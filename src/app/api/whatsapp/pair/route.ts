import { NextResponse } from 'next/server';
import { requestPairingCode } from '@/lib/whatsapp-client';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { phoneNumber } = body;

        if (!phoneNumber || typeof phoneNumber !== 'string') {
            return NextResponse.json(
                { message: 'A valid phone number is required.' },
                { status: 400 }
            );
        }

        // Strip everything except digits for validation
        const digits = phoneNumber.replace(/\D/g, '');
        if (digits.length < 7 || digits.length > 15) {
            return NextResponse.json(
                { message: 'Phone number must be between 7 and 15 digits including country code.' },
                { status: 400 }
            );
        }

        const pairingCode = await requestPairingCode(phoneNumber);
        return NextResponse.json({ pairingCode });
    } catch (error) {
        console.error('Pairing code request failed:', error);
        return NextResponse.json(
            { message: (error as Error).message || 'Failed to generate pairing code.' },
            { status: 500 }
        );
    }
}
