import "./globals.css";
import { ProjectProvider } from "@/lib/projectContext";

export const metadata = { title: "Scheduler Control Plane", description: "Distributed job scheduler operations dashboard" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <ProjectProvider>{children}</ProjectProvider>
      </body>
    </html>
  );
}
