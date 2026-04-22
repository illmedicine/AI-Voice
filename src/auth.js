import { config } from './config.js';

export function requireApiKey(req, res, next) {
  // If no keys are configured, allow through (dev mode) — a warning was logged at boot.
  if (config.apiKeys.length === 0) return next();

  const provided =
    req.get('x-api-key') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

  if (provided && config.apiKeys.includes(provided)) return next();

  res.status(401).json({ error: 'Unauthorized. Provide a valid x-api-key header.' });
}
