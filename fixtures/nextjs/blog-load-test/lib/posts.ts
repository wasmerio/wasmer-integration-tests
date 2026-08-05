export interface Post {
  slug: string;
  title: string;
  body: string;
}

const POST_COUNT = 25;

// Single source of truth for the fixture's routes: both the Next.js pages and
// loadtest/nextjs/nextjs-load-test.ts import this list, so the load test never
// needs to crawl or read a build manifest to discover URLs.
export const POSTS: Post[] = Array.from(
  { length: POST_COUNT },
  (_, index) => {
    const n = index + 1;
    return {
      slug: `post-${n}`,
      title: `Load test post #${n}`,
      body: `This is the body of load test post number ${n}. It exists to give the load test a distinct route to exercise; the page is rendered on the server for every request.`,
    };
  },
);
