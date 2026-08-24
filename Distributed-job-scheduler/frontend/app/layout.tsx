import "./globals.css";

export const metadata = { title: "Scheduler Control Plane", description: "Distributed job scheduler operations dashboard" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
