import Link from "next/link";
export default function Home() {
  return (
    <main style={{ maxWidth: 640, margin: "80px auto" }}>
      <h1>GateKeep</h1>
      <p>Find the music. Book the night.</p>
      <p><Link href="/sign-in">Sign in</Link> · <Link href="/dashboard">Dashboard</Link></p>
    </main>
  );
}
