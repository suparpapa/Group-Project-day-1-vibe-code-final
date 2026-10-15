import type { Request, Response } from 'express';

export default async function handler(req: Request, res: Response) {
  const onemapToken = process.env.ONEMAP_TOKEN || process.env.ONEMAP_API_KEY || '';
  const isConfigured = Boolean(onemapToken && onemapToken.trim().length > 0);

  return res.status(200).json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    services: {
      onemap: {
        configured: isConfigured,
        message: isConfigured 
          ? 'OneMap API token configured in environment' 
          : 'ONEMAP_TOKEN not yet configured. Live proxy ready to receive credentials.',
      },
      endpoints: [
        '/api/health',
        '/api/revgeocode',
        '/api/busarrival',
      ],
    },
  });
}
