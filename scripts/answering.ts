/*
 * Which build of the game answers at a web app's address, and the wait for there to be only one.
 *
 * Google does not move a web app to a version at once. For about a minute after it is given one, calls
 * to its address are answered by the version it had and by the new one, call by call. A page that
 * hears from another build than its own stops and asks to be reloaded, so an address is ready for
 * anyone only when a stretch of calls there has been answered by the one build alone.
 */

/** How one call to an address came out: the build that answered, null for code from before builds had ids, or why nothing can be told from it. */
export type Answer = { build: string | null } | { failed: string };

export interface Answers {
  /** Asks the address once. A call that got no answer, or none that can be read, says so and is no error. */
  ask(url: string): Promise<Answer>;
}

/** What a wait goes by: the answers, the time, and a way to let time pass. */
export interface Asking {
  answers: Answers;
  now(): Date;
  pause(ms: number): Promise<void>;
}

/** How long a build must have been the only one to answer before an address is taken to serve it alone. Strays were seen eight seconds apart. */
export const QUIET_MS = 45_000;

/** How long the wait for that goes on before it is given up. Google was seen to take under a minute. */
export const SETTLE_DEADLINE_MS = 300_000;

// A round is this many calls at once, and the next round follows this long after its last answer
const AT_A_TIME = 4;
const BETWEEN_ROUNDS_MS = 250;
const CALL_TIMEOUT_MS = 20_000;

/**
 * What is sent to ask. It is no request of the game's, so the script turns it away before it reads or
 * writes anything, and what it turns it away with carries its build like any answer.
 */
export const QUESTION = 'Which build answers here?';

/** A build in words. */
export const named = (build: string | null): string => (build === null ? 'code from before builds had ids' : `build ${build}`);

/** What one round of calls to an address heard: each build that answered, and what the calls that told nothing said. */
export interface Round {
  builds: (string | null)[];
  failed: string[];
}

export async function askRound(answers: Answers, url: string): Promise<Round> {
  const heard = await Promise.all(Array.from({ length: AT_A_TIME }, () => answers.ask(url)));

  return {
    builds: [...new Set(heard.flatMap((answer) => ('build' in answer ? [answer.build] : [])))],
    failed: [...new Set(heard.flatMap((answer) => ('failed' in answer ? [answer.failed] : [])))],
  };
}

/** How a wait for one build to be the only one answering came out. */
export interface Settling {
  /** Whether a whole stretch of calls was answered by the build and by nothing else. */
  settled: boolean;
  /** Whether the build answered at all. */
  heard: boolean;
  /** The last call that was not answered by the build, in words, or null when every call was. */
  other: string | null;
}

/**
 * Asks an address round after round until `build` alone has answered for a whole stretch, or the
 * deadline. A call that got no answer starts the stretch over like one another build answered: it
 * shows nothing of which build would have.
 */
export async function untilOnly(build: string, url: string, { answers, now, pause }: Asking): Promise<Settling> {
  const began = now().getTime();
  let heard = false;
  let other: { at: number; said: (seconds: number) => string } | null = null;

  for (;;) {
    const { builds, failed } = await askRound(answers, url);
    const at = now().getTime();
    const stray = builds.find((each) => each !== build);

    heard ||= builds.includes(build);

    if (stray !== undefined) {
      other = { at, said: (seconds) => `${named(stray)} answered ${seconds} s ago` };
    } else if (failed.length > 0) {
      other = { at, said: (seconds) => `a call ${seconds} s ago got no answer (${failed.join(', ')})` };
    }

    const settled = at - (other?.at ?? began) >= QUIET_MS;

    if (settled || at - began >= SETTLE_DEADLINE_MS) {
      return { settled, heard, other: other && other.said(Math.round((at - other.at) / 1000)) };
    }

    await pause(BETWEEN_ROUNDS_MS);
  }
}

/** As much of `fetch` as asking takes. */
type Post = (url: string, init: { method: 'POST'; body: string; redirect: 'follow'; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

function whyNot(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const code = (error.cause as { code?: unknown } | undefined)?.code;

  return typeof code === 'string' ? code : error.name === 'TimeoutError' ? `none in ${CALL_TIMEOUT_MS / 1000} s` : error.message;
}

/**
 * A web app's answers as a POST to its address gets them, which is how a page hosted somewhere else
 * reaches the script, and needs no browser. `post` is `fetch`.
 */
export function answersOver(post: Post): Answers {
  return {
    async ask(url) {
      let status: number;
      let text: string;

      try {
        const response = await post(url, { method: 'POST', body: QUESTION, redirect: 'follow', signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });

        status = response.status;
        text = await response.text();
      } catch (error) {
        return { failed: whyNot(error) };
      }

      let answer: unknown;

      try {
        answer = JSON.parse(text);
      } catch {
        // Google's own page for a script that failed, or for one that may not be opened without signing in
        return { failed: `HTTP ${status}, and nothing the game answers with` };
      }

      if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
        return { failed: `HTTP ${status}, and nothing the game answers with` };
      }

      const { build } = answer as { build?: unknown };

      return { build: typeof build === 'string' ? build : null };
    },
  };
}
