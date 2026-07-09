import { OAuth2Client } from 'google-auth-library';

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

  if (!clientId) {
    // ----------------------------------------------------
    // DEMO / BYPASS MODE (No Client ID configured in .env)
    // ----------------------------------------------------
    if (token === 'mock-google-token-id') {
      req.user = {
        email: 'demo.developer@pzero.io',
        name: 'Sviluppatore PZero (Demo)',
        picture: '' // Empty picture will fallback to initials in frontend
      };
      return next();
    }
    
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

    // Attach verified user info to request
    req.user = {
      email: payload.email,
      name: payload.name,
      picture: payload.picture
    };

    next();
  } catch (error) {
    console.error('[Auth Error] Google token verification failed:', error.message);
    res.status(401).json({ error: `Authentication failed: ${error.message}` });
  }
}
