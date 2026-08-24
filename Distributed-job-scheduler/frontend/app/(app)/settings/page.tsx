import { PageHeader } from "@/components/Shell";
export default function SettingsPage() { return <><PageHeader eyebrow="Workspace / settings" title="Workspace settings" detail="Backend-managed organization settings are not exposed by the current API." /><section className="panel empty">No editable settings endpoint is available.</section></>; }
