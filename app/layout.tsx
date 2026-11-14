import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://votar.portalmilano.com'),
  title: {
    default: 'Assembleia Geral • Milano Condomínio Club',
    template: '%s • Milano Condomínio Club',
  },
  description:
    'Plataforma oficial de credenciamento e votação deliberativa em tempo real da Assembleia Geral do Milano Condomínio Club.',
  openGraph: {
    title: 'Assembleia Geral • Milano Condomínio Club',
    description: 'Credenciamento de presença e votação ao vivo por unidade.',
    url: 'https://votar.portalmilano.com',
    siteName: 'Milano Condomínio Club',
    images: [{ url: '/brand/logo-mark.png', width: 512, height: 512 }],
    locale: 'pt_BR',
    type: 'website',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#0C0C0D',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
