import type { Request, Response } from 'express';

interface GeocodeItem {
  BUILDING?: string;
  BLOCK?: string;
  ROAD?: string;
  POSTALCODE?: string;
  LATITUDE?: string;
  LONGITUDE?: string;
}

export default async function handler(req: Request, res: Response) {
  // Query parameters
  const location = (req.query.location as string) || '1.2979,103.8489';
  const buffer = (req.query.buffer as string) || '40';
  const addressType = (req.query.addressType as string) || 'All';

  // Authorization token from environment or header (never hardcoded)
  const token = 
    process.env.ONEMAP_TOKEN || 
    process.env.ONEMAP_API_KEY || 
    (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '').trim() : '') ||
    '';

  const onemapUrl = `https://www.onemap.gov.sg/api/public/revgeocode?location=${encodeURIComponent(location)}&buffer=${encodeURIComponent(buffer)}&addressType=${encodeURIComponent(addressType)}`;

  // If a token is supplied, call the live OneMap endpoint
  if (token) {
    try {
      const apiRes = await fetch(onemapUrl, {
        method: 'GET',
        headers: {
          'Authorization': token.startsWith('Bearer ') ? token : token,
          'Accept': 'application/json',
          'User-Agent': 'CrewVoyage-Singapore-Planner/1.0'
        }
      });

      if (apiRes.ok) {
        const data = await apiRes.json();
        return res.status(200).json({
          status: 'success',
          source: 'onemap_live',
          urlQueried: onemapUrl,
          location,
          configured: true,
          data
        });
      } else {
        const errText = await apiRes.text();
        return res.status(apiRes.status).json({
          status: 'error',
          source: 'onemap_live_error',
          statusCode: apiRes.status,
          message: 'OneMap API responded with an error (verify ONEMAP_TOKEN validity)',
          details: errText,
          fallback: getLocalFallbackAddress(location)
        });
      }
    } catch (err: any) {
      console.error('OneMap fetch failure:', err?.message || err);
      return res.status(502).json({
        status: 'error',
        source: 'onemap_connection_failed',
        message: err?.message || 'Failed to reach onemap.gov.sg',
        fallback: getLocalFallbackAddress(location)
      });
    }
  }

  // If no token is configured, return clear instructions along with Singapore coordinate resolution
  return res.status(200).json({
    status: 'unconfigured_ready',
    source: 'onemap_stub_ready',
    message: 'ONEMAP_TOKEN not yet configured in environment. Endpoint is operational and waiting for token.',
    urlTarget: onemapUrl,
    location,
    configured: false,
    data: getLocalFallbackAddress(location)
  });
}

function getLocalFallbackAddress(locStr: string) {
  const [lat, lng] = locStr.split(',').map((s) => parseFloat(s.trim()));

  // Proximity lookup to key Singapore landmark coordinates
  if (Math.abs(lat - 1.2806) < 0.01 && Math.abs(lng - 103.8504) < 0.01) {
    return {
      GeocodeInfo: [
        {
          BUILDING: 'LAU PA SAT FESTIVAL MARKET (TELOK AYER MARKET)',
          BLOCK: '18',
          ROAD: 'RAFFLES QUAY',
          POSTALCODE: '048582',
          LATITUDE: '1.2806',
          LONGITUDE: '103.8504'
        }
      ]
    };
  }

  if (Math.abs(lat - 1.2979) < 0.01 && Math.abs(lng - 103.8489) < 0.01) {
    return {
      GeocodeInfo: [
        {
          BUILDING: 'FORT CANNING PARK / DHOBY GHAUT HERITAGE PRECINCT',
          BLOCK: '70',
          ROAD: 'RIVER VALLEY ROAD',
          POSTALCODE: '179037',
          LATITUDE: '1.2979',
          LONGITUDE: '103.8489'
        }
      ]
    };
  }

  return {
    GeocodeInfo: [
      {
        BUILDING: 'SINGAPORE DOWNTOWN CORE / HERITAGE PRECINCT',
        BLOCK: '-',
        ROAD: 'CROSS STREET / TELOK AYER',
        POSTALCODE: '048421',
        LATITUDE: String(lat || 1.2806),
        LONGITUDE: String(lng || 103.8504)
      }
    ]
  };
}
