import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cfIp = request.headers.get('cf-connecting-ip');
  const realIp = request.headers.get('x-real-ip');
  const forwardedFor = request.headers.get('x-forwarded-for');
  const userAgent = request.headers.get('user-agent') || '';

  const ip =
    cfIp?.trim() ||
    realIp?.trim() ||
    forwardedFor?.split(',')[0]?.trim() ||
    'IP-Local';

  return NextResponse.json(
    {
      ip,
      userAgent,
      timestamp: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    }
  );
}

