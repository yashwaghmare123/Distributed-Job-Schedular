"use client";

import { FormEvent, useState } from "react";
import { apiClient } from "@/lib/api";
import { Failure, PageHeader } from "@/components/Shell";

export default function ApiKeysPage() { const [name, setName] = useState(""); const [secret, setSecret] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const submit = async (event: FormEvent) => { event.preventDefault(); try { const result = await apiClient.createApiKey(name); setSecret(String(result.apiKey)); setName(""); } catch (err) { setError(err instanceof Error ? err.message : "Unable to create API key"); } }; return <><PageHeader eyebrow="Security / credentials" title="API keys" detail="Secrets are shown once at creation and never stored by the dashboard." /> <section className="panel"><form className="form-grid" onSubmit={submit}>{error && <Failure message={error} />}<div className="field"><label htmlFor="key-name">Key name</label><input id="key-name" value={name} onChange={(event) => setName(event.target.value)} required /></div><button className="button" type="submit">Create one-time secret</button></form>{secret && <div className="error" style={{ marginTop: 20 }}>Copy this secret now: <span className="mono">{secret}</span></div>}</section></>; }
