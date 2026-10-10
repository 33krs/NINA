import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'NINA',
  description: 'Sistema de Información en Salud',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
