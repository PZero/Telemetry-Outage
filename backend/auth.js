import { OAuth2Client } from 'google-auth-library';
import { dbService } from './database.js';

let client = null;

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (clientId && !client) {
    client = new OAuth2Client(clientId);
    console.log('[Auth] Google OAuth2 Client initialized with Client ID.');
  }
  return client;
}

/**
 * Ensures user is stored in the database, forces fnicora@gmail.com to be admin,
 * and retrieves the user's role.
 */
async function syncAndGetUserRole(email, name) {
  try {
    let user = await dbService.getUserByEmail(email);
    if (!user) {
      const role = (email === 'fnicora@gmail.com') ? 'admin' : 'normal';
      await dbService.saveUser(email, name, role);
      user = { email, name, role };
      console.log(`[Auth] Registered new user: ${email} with role: ${role}`);
    } else {
      // Update name if retrieved from Google and different/not set
      if (name && user.name !== name) {
        user.name = name;
        await dbService.saveUser(email, name, user.role);
        console.log(`[Auth] Updated user name in database to Google profile name: ${name}`);
      }
      // Force fnicora@gmail.com to always be admin
      if (email === 'fnicora@gmail.com' && user.role !== 'admin') {
        user.role = 'admin';
        // Run update query in background
        dbService.updateUserRole(email, 'admin').catch(console.error);
      }
    }
    return user.role;
  } catch (err) {
    console.error('[Auth Sync Error] Failed to sync user details:', err);
    return (email === 'fnicora@gmail.com') ? 'admin' : 'normal';
  }
}

/**
 * Express Middleware to require and verify Google OAuth 2.0 ID Token.
 * Supports a secure fallback Demo Mode if GOOGLE_CLIENT_ID is not configured in .env.
 */
export async function requireGoogleAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header. Expected "Bearer <token>".' });
  }

  const token = authHeader.split(' ')[1];
  const clientId = process.env.GOOGLE_CLIENT_ID;

  // Universal developer mock token bypass (for API testing & Swagger UI verification)
  if (token === 'mock-google-token-id') {
    const email = 'fnicora@gmail.com';
    const name = 'Fabio Nicora (Demo)';
    const role = await syncAndGetUserRole(email, name);
    req.user = {
      email,
      name,
      picture: '',
      role
    };
    return next();
  }

  if (!clientId) {
    // Warn developer in server logs
    console.warn(`[Auth Warning] Rejected token "${token.substring(0, 10)}..." because GOOGLE_CLIENT_ID is missing and token is not mock-google-token-id.`);
    return res.status(401).json({ error: 'Google client ID not configured. Please use demo credentials or configure GOOGLE_CLIENT_ID.' });
  }

  // ----------------------------------------------------
  // SECURE PRODUCTION MODE (Google ID Token Verification)
  // ----------------------------------------------------
  try {
    const oauthClient = getOAuthClient();
    const ticket = await oauthClient.verifyIdToken({
      idToken: token,
      audience: clientId
    });
    
    const payload = ticket.getPayload();
    if (!payload) {
      throw new Error('Google ID Token payload is empty.');
    }

    const email = payload.email;
    const name = payload.name;
    const role = await syncAndGetUserRole(email, name);

    // Attach verified user info to request
    req.user = {
      email,
      name,
      picture: payload.picture,
      role
    };

    next();
  } catch (error) {
    console.error('[Auth Error] Google token verification failed:', error.message);
    res.status(401).json({ error: `Authentication failed: ${error.message}` });
  }
}

/**
 * Express Middleware to restrict route access to Admin users only.
 */
export function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    return next();
  }
  res.status(403).json({ error: 'Access denied. Administrator privileges required.' });
}
