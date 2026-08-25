"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { apiClient } from "@/lib/api";
import { Failure } from "@/components/Shell";

export default function RegisterPage() { const router = useRouter(); const [error, setError] = useState<string | null>(null); const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); try { await apiClient.register({ name: String(data.get("name")), email: String(data.get("email")), password: String(data.get("password")) }); router.replace("/projects"); } catch (err) { setError(err instanceof Error ? err.message : "Unable to register"); } }; return <main className="auth-page"><section className="auth-card"><div className="kicker">Scheduler Ops</div><h1>Start operating.</h1><p className="subtle">Your default organization is created automatically.</p><form className="form-grid" onSubmit={submit}>{error && <Failure message={error} />}<div className="field"><label htmlFor="name">Name</label><input id="name" name="name" required /></div><div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" required /></div><div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" minLength={8} required /></div><button className="button" type="submit">Create workspace</button></form><p className="subtle" style={{ marginTop: 25 }}>Already registered? <Link href="/login">Sign in</Link></p></section></main>; }
