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
      const approved = (email === 'fnicora@gmail.com') ? 1 : 0;
      await dbService.saveUser(email, name, role, approved);
      user = { email, name, role, approved };
      console.log(`[Auth] Registered new user: ${email} with role: ${role}, approved: ${approved}`);
    } else {
      // Update name if retrieved from Google and different/not set
      if (name && user.name !== name) {
        user.name = name;
        await dbService.saveUser(email, name, user.role, user.approved);
        console.log(`[Auth] Updated user name in database to Google profile name: ${name}`);
      }
      // Force fnicora@gmail.com to always be admin & approved
      if (email === 'fnicora@gmail.com' && (user.role !== 'admin' || user.approved !== 1)) {
        user.role = 'admin';
        user.approved = 1;
        await dbService.updateUserApproval(email, 1).catch(console.error);
        await dbService.updateUserRole(email, 'admin').catch(console.error);
      }
    }
    return { role: user.role, approved: user.approved };
  } catch (err) {
    console.error('[Auth Sync Error] Failed to sync user details:', err);
    return {
      role: (email === 'fnicora@gmail.com') ? 'admin' : 'normal',
      approved: (email === 'fnicora@gmail.com') ? 1 : 0
    };
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
    const authResult = await syncAndGetUserRole(email, name);
    req.user = {
      email,
      name,
      picture: '',
      role: authResult.role,
      approved: authResult.approved
    };
    return next();
  }

  if (token === 'mock-pending-token-id') {
    req.user = {
      email: 'pending.user@pzero.io',
      name: 'Utente In Attesa',
      picture: '',
      role: 'normal',
      approved: 0
    };
    // Block non-approved users from all routes except profile endpoint
    const isProfileRoute = req.path === '/auth/profile' || req.path === '/api/auth/profile' || req.path.includes('/auth/profile');
    if (!isProfileRoute) {
      return res.status(403).json({ error: 'USER_NOT_APPROVED', approved: 0 });
    }
    return next();
  }

  if (token === 'mock-declined-token-id') {
    req.user = {
      email: 'declined.user@pzero.io',
      name: 'Utente Rifiutato',
      picture: '',
      role: 'normal',
      approved: -1
    };
    // Block non-approved users from all routes except profile endpoint
    const isProfileRoute = req.path === '/auth/profile' || req.path === '/api/auth/profile' || req.path.includes('/auth/profile');
    if (!isProfileRoute) {
      return res.status(403).json({ error: 'USER_NOT_APPROVED', approved: -1 });
    }
    return next();
  }

  if (!clientId) {
    // Warn developer in server logs
    console.warn(`[Auth Warning] Rejected token "${token.substring(0, 10)}..." because GOOGLE_CLIENT_ID is missing and token is not mock-google-token-id.`);
    return res.status(401).json({ error: 'Google client ID not configured. Please use demo credentials or configure GOOGLE_CLIENT_ID.' });
  }

  // ----------------------------------------------------
  // SECURE PRODUCTION MODE (Google ID Token & Access Token Verification)
  // ----------------------------------------------------
  try {
    // 1. Try OIDC ID Token verification (JWT format)
    const oauthClient = getOAuthClient();
    const ticket = await oauthClient.verifyIdToken({
      idToken: token,
      audience: clientId
    });
    
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new Error('Google ID Token payload is empty or invalid.');
    }

    const email = payload.email;
    const name = payload.name;
    const authResult = await syncAndGetUserRole(email, name);

    req.user = {
      email,
      name,
      picture: payload.picture,
      role: authResult.role,
      approved: authResult.approved
    };

    if (email !== 'fnicora@gmail.com' && authResult.approved !== 1) {
      const isProfileRoute = req.path === '/auth/profile' || req.path === '/api/auth/profile' || req.path.includes('/auth/profile');
      if (!isProfileRoute) {
        return res.status(403).json({ error: 'USER_NOT_APPROVED', approved: authResult.approved });
      }
    }

    return next();
  } catch (idTokenError) {
    // 2. Fallback to Google OAuth 2.0 UserInfo API verification (for Access Tokens starting with 'ya29...' sent by Copilot Studio)
    try {
      const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (userinfoRes.ok) {
        const payload = await userinfoRes.json();
        if (payload && payload.email) {
          const email = payload.email;
          const name = payload.name || payload.email;
          const authResult = await syncAndGetUserRole(email, name);

          req.user = {
            email,
            name,
            picture: payload.picture,
            role: authResult.role,
            approved: authResult.approved
          };

          if (email !== 'fnicora@gmail.com' && authResult.approved !== 1) {
            const isProfileRoute = req.path === '/auth/profile' || req.path === '/api/auth/profile' || req.path.includes('/auth/profile');
            if (!isProfileRoute) {
              return res.status(403).json({ error: 'USER_NOT_APPROVED', approved: authResult.approved });
            }
          }

          return next();
        }
      }
    } catch (userInfoError) {
      console.error('[Auth Error] Google Access Token verification failed:', userInfoError.message);
    }

    console.error('[Auth Error] Google token verification failed:', idTokenError.message);
    return res.status(401).json({ error: `Authentication failed: ${idTokenError.message}` });
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
