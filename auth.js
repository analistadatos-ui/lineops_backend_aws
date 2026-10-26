// auth.js — signed login tokens (JWT) + security log lines for CloudWatch alarms.
//
// Replaces the old token  base64("userId:time")  which anyone could forge for any
// user without a password. Tokens are now signed with JWT_SECRET; a token that
// was not issued by this server is rejected.
//
// SETUP (server.js)
//   1. npm install jsonwebtoken
//   2. After `applyRoleAlias` is defined, replace the old /api/login route and the
//      old `const authenticateToken = async (req, res, next) => { … }` with:
//
//        const createAuth = require("./auth");
//        const { loginHandler, authenticateToken } = createAuth({ pool, setSchema, applyRoleAlias });
//        app.post("/api/login", loginHandler);
//
//      Everything else that uses `authenticateToken` keeps working unchanged.
//   3. Lambda environment (already there): JWT_SECRET, JWT_EXPIRES_IN (e.g. 24h)
//      Optional: OFFICE_IPS = comma-separated public IPs of your sites
//                (e.g. "201.150.10.20,187.190.5.6"). Logins from other IPs are
//                still allowed but logged as SECURITY login_outside_office.
//
// After deploying, every user logs in once again (old tokens stop working).
//
// Security log lines (one JSON line each, never with passwords or tokens):
//   SECURITY login_failed           wrong user/password          → alarm: ≥ 5 in 5 min
//   SECURITY login_outside_office   successful login, unknown IP → alarm: ≥ 1
//   SECURITY token_invalid          forged/tampered/expired token → alarm: ≥ 20 in 5 min
//   SECURITY login_ok               successful login (for the audit trail)

const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const MIN_SECRET_LENGTH = 32;

// Real visitor IP behind CloudFront → API Gateway.
// CloudFront appends the viewer IP to X-Forwarded-For, then API Gateway appends
// CloudFront's own IP, so the viewer is the second-to-last entry. Anything before
// it could have been typed by the client and is ignored.
function clientIp(req) {
  const parts = String(req.headers["x-forwarded-for"] || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  if (parts.length === 1) return parts[0];
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function security(event, fields) {
  // One line, easy to match in CloudWatch metric filters: "SECURITY login_failed"
  console.warn(`SECURITY ${event} ${JSON.stringify({ event, at: new Date().toISOString(), ...fields })}`);
}

function createAuth({ pool, setSchema, applyRoleAlias = (u) => u }) {
  const secret = process.env.JWT_SECRET || "";
  if (secret.length < MIN_SECRET_LENGTH) {
    // Fail loudly at startup instead of running with weak or missing signing.
    throw new Error(`JWT_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const expiresIn = process.env.JWT_EXPIRES_IN || "24h";
  const officeIps = new Set(
    String(process.env.OFFICE_IPS || "").split(",").map((s) => s.trim()).filter(Boolean)
  );

  async function loginHandler(req, res) {
    const ip = clientIp(req);
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: "Username and password are required" });
    }
    const client = await pool.connect();
    try {
      await setSchema(client);
      const { rows } = await client.query(
        `SELECT id, username, password_hash, role, line_number, full_name, is_active
           FROM users WHERE username = $1 AND is_active = TRUE`,
        [username]
      );
      const user = rows[0];
      const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
      if (!ok) {
        security("login_failed", { username: String(username).slice(0, 80), ip, reason: user ? "bad_password" : "unknown_user" });
        return res.status(401).json({ success: false, error: "Invalid username or password" });
      }
      delete user.password_hash;
      applyRoleAlias(user);

      const token = jwt.sign({ sub: String(user.id), role: user.role }, secret, {
        algorithm: "HS256",
        expiresIn,
      });

      const outside = officeIps.size > 0 && !officeIps.has(ip);
      security(outside ? "login_outside_office" : "login_ok", { userId: user.id, username: user.username, role: user.role, ip });

      res.json({ success: true, message: "Login successful", user, token });
    } catch (err) {
      console.error("❌ Login error:", err.message);
      res.status(500).json({ success: false, error: "Internal server error" });
    } finally {
      client.release();
    }
  }

  async function authenticateToken(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    let payload;
    try {
      payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
    } catch (err) {
      const expired = err.name === "TokenExpiredError";
      if (!expired) security("token_invalid", { ip: clientIp(req), reason: err.message, path: req.originalUrl?.slice(0, 120) });
      return res.status(401).json({ success: false, error: expired ? "Session expired" : "Invalid authentication token" });
    }

    const client = await pool.connect();
    try {
      await setSchema(client);
      const { rows } = await client.query(
        `SELECT id, username, role, line_number, full_name
           FROM users WHERE id = $1 AND is_active = TRUE`,
        [parseInt(payload.sub, 10)]
      );
      if (!rows.length) {
        security("token_invalid", { ip: clientIp(req), reason: "user_inactive_or_missing", userId: payload.sub });
        return res.status(401).json({ success: false, error: "User not found or inactive" });
      }
      req.user = applyRoleAlias(rows[0]);
      next();
    } catch (err) {
      console.error("❌ Authentication error:", err.message);
      res.status(500).json({ success: false, error: "Internal server error" });
    } finally {
      client.release();
    }
  }

  return { loginHandler, authenticateToken, clientIp };
}

module.exports = createAuth;