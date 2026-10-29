const ACCESS_TOKEN_HEADER = 'cf-access-jwt-assertion';
const ACCESS_CLOCK_SKEW_SECONDS = 60;

let cachedKeys;
let cachedKeysExpiresAt = 0;

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function decodeJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

function normalizeTeamDomain(value) {
  return value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

async function loadAccessKeys(teamDomain, forceRefresh = false) {
  if (!forceRefresh && cachedKeys && cachedKeysExpiresAt > Date.now()) return cachedKeys;

  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Cloudflare Access certificate endpoint returned HTTP ${response.status}.`);
  const data = await response.json();
  if (!Array.isArray(data.keys)) throw new Error('Cloudflare Access returned an invalid certificate list.');
  cachedKeys = data.keys;
  cachedKeysExpiresAt = Date.now() + 5 * 60 * 1000;
  return cachedKeys;
}

export async function verifyAccessAssertion(request, env) {
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN || '');
  const audience = (env.ACCESS_AUD || '').trim();
  if (!teamDomain || !audience ||
      teamDomain.startsWith('replace-with') ||
      audience.startsWith('replace-with')) {
    throw new Error('Set ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.jsonc before deploying.');
  }

  const token = request.headers.get(ACCESS_TOKEN_HEADER);
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let header;
  let claims;
  try {
    header = decodeJwtPart(parts[0]);
    claims = decodeJwtPart(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

  let keys = await loadAccessKeys(teamDomain);
  let jwk = keys.find(key => key.kid === header.kid);
  if (!jwk) {
    keys = await loadAccessKeys(teamDomain, true);
    jwk = keys.find(key => key.kid === header.kid);
  }
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const validSignature = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!validSignature) return null;

  const now = Math.floor(Date.now() / 1000);
  const tokenAudiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== `https://${teamDomain}` ||
      !tokenAudiences.includes(audience) ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= now - ACCESS_CLOCK_SKEW_SECONDS ||
      (Number.isFinite(claims.nbf) && claims.nbf > now + ACCESS_CLOCK_SKEW_SECONDS)) {
    return null;
  }
  return claims;
}
