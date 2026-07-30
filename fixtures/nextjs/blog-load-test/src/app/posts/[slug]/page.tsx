import Link from "next/link";
import { notFound } from "next/navigation";
import { POSTS } from "../../../../lib/posts";

export const dynamic = "force-dynamic";

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = POSTS.find((candidate) => candidate.slug === slug);
  if (!post) {
    notFound();
  }

  return (
    <main>
      <p>
        <Link href="/">Back</Link>
      </p>
      <h1>{post.title}</h1>
      <p>Rendered at {new Date().toISOString()}</p>
      <p>{post.body}</p>
    </main>
  );
}
