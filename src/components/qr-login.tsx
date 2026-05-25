
'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Loader2, AlertCircle, Smartphone, QrCode, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

type Status = 'connecting' | 'connected' | 'disconnected' | 'error';
type LoginMode = 'qr' | 'phone';

export default function QRLogin() {
  const router = useRouter();

  // --- Shared state ---
  const [loginMode, setLoginMode] = useState<LoginMode>('qr');
  const [status, setStatus] = useState<Status>('connecting');
  const [message, setMessage] = useState('Initializing...');
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // --- QR mode state ---
  const [qrCode, setQrCode] = useState<string | null>(null);

  // --- Phone mode state ---
  const [phoneNumber, setPhoneNumber] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [isRequestingCode, setIsRequestingCode] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ─── Polling ────────────────────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/whatsapp/status', { cache: 'no-store' });
        if (!res.ok) throw new Error('Status check failed');
        const data = await res.json();

        setStatus(data.status);

        if (data.status === 'connected') {
          setMessage('Successfully connected! Redirecting...');
          stopPolling();
          setTimeout(() => router.push('/dashboard'), 1000);
        } else if (data.status === 'connecting') {
          if (loginMode === 'qr') {
            if (data.qr) {
              setQrCode(data.qr);
              setMessage('Scan this QR code with the WhatsApp mobile app.');
            } else {
              setQrCode(null);
              setMessage('Generating QR code, please wait...');
            }
          }
          // In phone mode, just keep polling until connected
        } else {
          setQrCode(null);
          setMessage(data.lastDisconnect?.reason || 'Connection failed. Please try again.');
          stopPolling();
        }
      } catch {
        setStatus('error');
        setMessage('An error occurred while checking status.');
        stopPolling();
      }
    }, 2000);
  }, [stopPolling, router, loginMode]);

  // ─── QR Mode: fresh connection ───────────────────────────────────────────────

  const startFreshConnection = useCallback(async () => {
    stopPolling();
    setStatus('connecting');
    setMessage('Requesting a new QR code...');
    setQrCode(null);
    setPairingCode(null);
    setPhoneError(null);

    try {
      await fetch('/api/whatsapp/logout', { method: 'POST' });
      await fetch('/api/whatsapp/init', { method: 'POST' });
      startPolling();
    } catch {
      setStatus('error');
      setMessage('Failed to contact server. Please check your connection.');
      stopPolling();
    }
  }, [startPolling, stopPolling]);

  // ─── Phone Mode: request pairing code ───────────────────────────────────────

  const handleRequestPairingCode = async () => {
    setPhoneError(null);
    const digits = phoneNumber.replace(/\D/g, '');
    if (digits.length < 7) {
      setPhoneError('Please enter a valid phone number including your country code.');
      return;
    }

    setIsRequestingCode(true);
    setPairingCode(null);

    try {
      const res = await fetch('/api/whatsapp/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber }),
      });
      const data = await res.json();

      if (!res.ok) {
        setPhoneError(data.message || 'Failed to generate pairing code.');
        return;
      }

      setPairingCode(data.pairingCode);
      setStatus('connecting');
      setMessage('Enter the code below in WhatsApp → Settings → Linked Devices → Link with Phone Number.');
      startPolling();
    } catch {
      setPhoneError('Could not reach the server. Please try again.');
    } finally {
      setIsRequestingCode(false);
    }
  };

  const handleCopyCode = () => {
    if (!pairingCode) return;
    navigator.clipboard.writeText(pairingCode.replace('-', ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  useEffect(() => {
    startFreshConnection();
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset phone mode when switching tabs
  const handleModeChange = (val: string) => {
    const mode = val as LoginMode;
    setLoginMode(mode);
    setPairingCode(null);
    setPhoneError(null);
    setIsRequestingCode(false);
  };

  // ─── Derived display flags ────────────────────────────────────────────────────

  const showError = status === 'disconnected' || status === 'error';
  const showQrLoading = loginMode === 'qr' && status === 'connecting' && !qrCode;
  const showQR = loginMode === 'qr' && status === 'connecting' && !!qrCode;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4">
      {/* Branding */}
      <div className="mb-8 text-center">
        <h1 className="font-headline text-5xl font-bold text-primary">AIWhisper</h1>
        <p className="mt-2 text-lg text-muted-foreground">Your AI-Powered WhatsApp Hub</p>
      </div>

      <Card className="w-full max-w-sm shadow-2xl">
        <CardHeader className="text-center pb-2">
          <CardTitle className="font-headline text-2xl">Link your WhatsApp</CardTitle>
          <CardDescription>Choose how you want to connect.</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4 pt-2">
          {/* Mode Tabs */}
          <Tabs value={loginMode} onValueChange={handleModeChange}>
            <TabsList className="w-full">
              <TabsTrigger value="qr" className="flex-1 gap-1.5">
                <QrCode className="h-4 w-4" /> Scan QR Code
              </TabsTrigger>
              <TabsTrigger value="phone" className="flex-1 gap-1.5">
                <Smartphone className="h-4 w-4" /> Phone Number
              </TabsTrigger>
            </TabsList>

            {/* ── QR Tab ── */}
            <TabsContent value="qr" className="mt-4 flex flex-col items-center gap-4">
              <p className="min-h-[36px] text-center text-sm text-muted-foreground px-2">
                {message}
              </p>

              <div className="relative flex h-64 w-64 items-center justify-center rounded-lg bg-white p-4 shadow-inner">
                {showQrLoading && <Loader2 className="h-12 w-12 animate-spin text-primary" />}
                {showQR && (
                  <Image src={qrCode!} alt="WhatsApp QR Code" width={256} height={256} priority />
                )}
                {showError && (
                  <div className="flex flex-col items-center text-center text-destructive">
                    <AlertCircle className="h-12 w-12" />
                    <p className="mt-4 font-semibold">Connection Failed</p>
                  </div>
                )}
              </div>

              {showError && (
                <Alert variant="destructive" className="w-full">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription className="break-words">{message}</AlertDescription>
                  <Button onClick={startFreshConnection} className="mt-3 w-full">
                    Try Again
                  </Button>
                </Alert>
              )}

              <p className="text-center text-xs text-muted-foreground px-2">
                Open WhatsApp on your phone → Settings → Linked Devices → Link a Device
              </p>
            </TabsContent>

            {/* ── Phone Tab ── */}
            <TabsContent value="phone" className="mt-4 space-y-4">
              {!pairingCode ? (
                <>
                  <p className="text-center text-sm text-muted-foreground">
                    Enter your WhatsApp number with country code and we'll generate a pairing code.
                  </p>

                  <div className="space-y-2">
                    <Input
                      id="phone-input"
                      type="tel"
                      placeholder="e.g. +2348012345678"
                      value={phoneNumber}
                      onChange={(e) => {
                        setPhoneNumber(e.target.value);
                        setPhoneError(null);
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && handleRequestPairingCode()}
                      disabled={isRequestingCode}
                    />
                    {phoneError && (
                      <p className="text-xs text-destructive">{phoneError}</p>
                    )}
                  </div>

                  <Button
                    className="w-full"
                    onClick={handleRequestPairingCode}
                    disabled={isRequestingCode || !phoneNumber.trim()}
                  >
                    {isRequestingCode ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      'Get Pairing Code'
                    )}
                  </Button>
                </>
              ) : (
                /* ── Pairing code display ── */
                <div className="flex flex-col items-center gap-4">
                  <p className="text-center text-sm text-muted-foreground px-2">
                    Enter this code in WhatsApp →{' '}
                    <span className="font-semibold text-foreground">
                      Settings → Linked Devices → Link with Phone Number
                    </span>
                  </p>

                  {/* Big styled code block */}
                  <div className="group relative flex w-full cursor-pointer items-center justify-center rounded-xl border-2 border-primary/40 bg-primary/5 px-6 py-5 transition hover:bg-primary/10"
                    onClick={handleCopyCode}
                    title="Click to copy"
                  >
                    <span className="font-mono text-4xl font-extrabold tracking-[0.25em] text-primary">
                      {pairingCode}
                    </span>
                    <button className="absolute right-3 top-3 text-muted-foreground transition hover:text-primary">
                      {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                    </button>
                  </div>

                  {copied && (
                    <p className="text-xs text-green-600 font-medium">Code copied!</p>
                  )}

                  {/* Waiting indicator */}
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span>Waiting for you to enter the code…</span>
                  </div>

                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      setPairingCode(null);
                      setPhoneError(null);
                      stopPolling();
                    }}
                  >
                    Use a different number
                  </Button>
                </div>
              )}

              {showError && !pairingCode && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Connection Error</AlertTitle>
                  <AlertDescription>{message}</AlertDescription>
                </Alert>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
