import Link from "next/link";
import { POSTS } from "../../lib/posts";

// Render on every request rather than serving a build-time-cached page, so
// the load test actually exercises the runtime under concurrency.
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1>Load test blog fixture</h1>
      <p>Rendered at {new Date().toISOString()}</p>
      <ul>
        {POSTS.map((post) => (
          <li key={post.slug}>
            <Link href={`/posts/${post.slug}`}>{post.title}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
