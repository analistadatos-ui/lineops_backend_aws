// Zero-dependency S3 client: uploads/deletes objects using Node's built-in
// `https` and `crypto` modules, signing requests with AWS Signature V4 by hand.
// No @aws-sdk/*, no multer, no multer-s3 — nothing to npm install.

const https = require("https");
const crypto = require("crypto");

const REQUIRED_ENV = ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "S3_BUCKET_NAME"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.warn(`⚠️ Missing env var ${key} — S3 photo uploads will fail until it is set`);
  }
}

const REGION = process.env.AWS_REGION;
const BUCKET = process.env.S3_BUCKET_NAME;
const HOST = `${BUCKET}.s3.${REGION}.amazonaws.com`;

// Read credentials fresh on every call. Under a Lambda execution role these are
// TEMPORARY and rotate over the life of the container; caching them at module
// load causes intermittent 403s after a rotation. REGION/BUCKET never change.
function getCredentials() {
  return {
    accessKey: process.env.AWS_ACCESS_KEY_ID,
    secretKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN, // undefined with static keys
  };
}

// --- AWS SigV4 helpers -----------------------------------------------------

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

// AWS requires a specific percent-encoding: unreserved chars (A-Z a-z 0-9 - _ . ~)
// are left alone, everything else is %XX encoded, and '/' in the path is preserved.
function awsUriEncode(str, encodeSlash = true) {
  let out = "";
  for (const ch of str) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) {
      out += ch;
    } else if (ch === "/") {
      out += encodeSlash ? "%2F" : "/";
    } else {
      const bytes = Buffer.from(ch, "utf8");
      for (const b of bytes) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

function canonicalPath(key) {
  // encode each path segment, keep the separating slashes
  return "/" + key.split("/").map((seg) => awsUriEncode(seg, true)).join("/");
}

function signRequest({ method, key, headers, payloadHash }) {
  const { accessKey, secretKey, sessionToken } = getCredentials();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // e.g. 20260706T201530Z
  const dateStamp = amzDate.slice(0, 8);

  const allHeaders = {
    host: HOST,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    // Temporary (role) credentials require the session token to be signed in.
    ...(sessionToken ? { "x-amz-security-token": sessionToken } : {}),
    ...headers,
  };

  const sortedHeaderKeys = Object.keys(allHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${allHeaders[k]}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [
    method,
    canonicalPath(key),
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { ...allHeaders, Authorization: authorization };
}

function request({ method, key, body, contentType }) {
  return new Promise((resolve, reject) => {
    const payloadHash = sha256Hex(body || Buffer.alloc(0));
    const extraHeaders = {};
    if (contentType) extraHeaders["content-type"] = contentType;
    if (body) extraHeaders["content-length"] = String(body.length);

    const headers = signRequest({ method, key, headers: extraHeaders, payloadHash });

    const req = https.request(
      {
        method,
        host: HOST,
        path: canonicalPath(key),
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, body: data });
          } else {
            reject(new Error(`S3 ${method} failed (${res.statusCode}): ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- Public API --------------------------------------------------------------

/**
 * Uploads a buffer to S3 and returns its public URL + key.
 */
async function uploadBufferToS3(buffer, key, contentType) {
  await request({ method: "PUT", key, body: buffer, contentType });
  return {
    url: `https://${HOST}/${canonicalPath(key).slice(1)}`,
    key,
  };
}

async function deleteFromS3(key) {
  if (!key) return;
  try {
    await request({ method: "DELETE", key });
  } catch (err) {
    console.error("⚠️ Failed to delete S3 object:", key, err.message);
  }
}

function makeStylePhotoKey(originalName = "") {
  const ext = (originalName.match(/\.[a-zA-Z0-9]+$/) || [""])[0].toLowerCase();
  return `style-photos/${Date.now()}-${crypto.randomUUID()}${ext}`;
}

/**
 * Generates a temporary signed GET URL for a private S3 object using
 * AWS SigV4 query-string signing (no request is made — this just builds a URL).
 */
function generatePresignedGetUrl(key, expiresInSeconds = 3600) {
  if (!key) return null;

  const { accessKey, secretKey, sessionToken } = getCredentials();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/s3/aws4_request`;

  const queryParams = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKey}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": "host",
    ...(sessionToken ? { "X-Amz-Security-Token": sessionToken } : {}),
  };

  // Build canonical query string: sorted by key, both key and value percent-encoded
  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map((k) => `${awsUriEncode(k, true)}=${awsUriEncode(queryParams[k], true)}`)
    .join("&");

  const canonicalHeaders = `host:${HOST}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    "GET",
    canonicalPath(key),
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return `https://${HOST}${canonicalPath(key)}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

/**
 * Generates a temporary signed PUT URL so the browser can upload an object
 * directly to S3. Only `host` is signed, so the client may send any
 * Content-Type. No request is made here — this just builds the URL.
 */
function generatePresignedPutUrl(key, expiresInSeconds = 300) {
  if (!key) return null;

  const { accessKey, secretKey, sessionToken } = getCredentials();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/s3/aws4_request`;

  const queryParams = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKey}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": "host",
    // THIS was missing — temporary (role) credentials need the session token,
    // signed as a query param, or S3 returns 403 on the PUT.
    ...(sessionToken ? { "X-Amz-Security-Token": sessionToken } : {}),
  };

  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map((k) => `${awsUriEncode(k, true)}=${awsUriEncode(queryParams[k], true)}`)
    .join("&");

  const canonicalHeaders = `host:${HOST}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    "PUT",                       // <-- only difference from the GET version
    canonicalPath(key),
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return `https://${HOST}${canonicalPath(key)}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

module.exports = { uploadBufferToS3, deleteFromS3, makeStylePhotoKey, generatePresignedGetUrl,generatePresignedPutUrl };