/**
 * Type-safe database read queries for the Pragyan API.
 *
 * Centralising every read here keeps the route handlers thin and gives one
 * place to maintain the ranking/XP/badge logic.
 */
import { drizzle } from "drizzle-orm/sql-js";
import { and, asc, eq, sql } from "drizzle-orm";
import { sqlite } from "../db";
import {
  chapters,
  mcqAttempts,
  mcqQuestions,
  notes,
  noteVotes,
  subjectiveAttempts,
  subjectiveQuestions,
  users,
  videos,
  xpEvents,
} from "../db/schema";

// A Drizzle instance bound to the shared in-memory sql.js database.
const db = drizzle(sqlite);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** sql.js returns millisecond epoch integers for timestamp columns — convert
 *  to ISO strings (the shape the frontend expects). */
function toIso(ms: number | null | undefined): string {
  const n = typeof ms === "number" && Number.isFinite(ms) ? ms : Date.now();
  return new Date(n).toISOString();
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

export type ChapterHead = {
  id: number;
  classNo: number;
  subjectSlug: string;
  subjectName: string;
  num: number;
  title: string;
  slug: string;
  summary: string | null;
  outcomeIds: string[];
  dikshaCode: string | null;
};

export async function getChapter(
  classNo: number,
  subjectSlug: string,
  slug: string,
): Promise<ChapterHead | null> {
  const rows = await db
    .select()
    .from(chapters)
    .where(
      and(
        eq(chapters.classNo, classNo),
        eq(chapters.subjectSlug, subjectSlug),
        eq(chapters.slug, slug),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export type ChapterListRow = {
  id: number;
  num: number;
  title: string;
  slug: string;
  summary: string | null;
  outcomeIds: string[];
  dikshaCode: string | null;
  videoCount: number;
  noteCount: number;
  mcqCount: number;
  pyqPct: number;
  subjCount: number;
  bestScore: number | null;
  bestTotal: number | null;
};

/**
 * Chapter list for a class/subject with per-chapter content counters and the
 * requesting user's best objective-test score.
 */
export async function getChapterList(
  classNo: number,
  subjectSlug: string,
  userId: number,
): Promise<ChapterListRow[]> {
  const rows = db.all<{
    id: number;
    num: number;
    title: string;
    slug: string;
    summary: string | null;
    outcome_ids: string | null;
    diksha_code: string | null;
    video_count: number | null;
    note_count: number | null;
    mcq_count: number | null;
    pyq_count: number | null;
    subj_count: number | null;
    best_score: number | null;
    best_total: number | null;
  }>(
    sql`
      SELECT
        c.id, c.num, c.title, c.slug, c.summary,
        c.outcome_ids, c.diksha_code,
        (SELECT COUNT(*) FROM videos v        WHERE v.chapter_id = c.id) AS video_count,
        (SELECT COUNT(*) FROM notes n         WHERE n.chapter_id = c.id) AS note_count,
        (SELECT COUNT(*) FROM mcq_questions q  WHERE q.chapter_id = c.id) AS mcq_count,
        (SELECT COUNT(*) FROM mcq_questions q  WHERE q.chapter_id = c.id AND q.is_pyq = 1) AS pyq_count,
        (SELECT COUNT(*) FROM subjective_questions s WHERE s.chapter_id = c.id) AS subj_count,
        (SELECT MAX(a.score) FROM mcq_attempts a
           WHERE a.chapter_id = c.id AND a.user_id = ${userId}) AS best_score,
        (SELECT MAX(a.total) FROM mcq_attempts a
           WHERE a.chapter_id = c.id AND a.user_id = ${userId}) AS best_total
      FROM chapters c
      WHERE c.class_no = ${classNo}
        ${subjectSlug ? sql`AND c.subject_slug = ${subjectSlug}` : sql``}
      ORDER BY c.subject_slug ASC, c.num ASC
    `,
  );

  return rows.map((r) => {
    let outcomeIds: string[] = [];
    try {
      const parsed = r.outcome_ids ? JSON.parse(r.outcome_ids) : [];
      if (Array.isArray(parsed)) outcomeIds = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      outcomeIds = [];
    }
    const mcqCount = num(r.mcq_count);
    const pyqCount = num(r.pyq_count);
    return {
      id: r.id,
      num: r.num,
      title: r.title,
      slug: r.slug,
      summary: r.summary,
      outcomeIds,
      dikshaCode: r.diksha_code,
      videoCount: num(r.video_count),
      noteCount: num(r.note_count),
      mcqCount,
      pyqPct: mcqCount > 0 ? Math.round((pyqCount / mcqCount) * 100) : 0,
      subjCount: num(r.subj_count),
      bestScore: r.best_score ?? null,
      bestTotal: r.best_total ?? null,
    };
  });
}

/** All videos, MCQs and subjective questions for one chapter. */
export async function getContentForChapter(chapterId: number) {
  const [videoRows, mcqRows, subjRows] = await Promise.all([
    db.select().from(videos).where(eq(videos.chapterId, chapterId)).orderBy(asc(videos.id)),
    db.select().from(mcqQuestions).where(eq(mcqQuestions.chapterId, chapterId)).orderBy(asc(mcqQuestions.id)),
    db
      .select()
      .from(subjectiveQuestions)
      .where(eq(subjectiveQuestions.chapterId, chapterId))
      .orderBy(asc(subjectiveQuestions.id)),
  ]);
  return { videos: videoRows, mcqs: mcqRows, subj: subjRows };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export type RankedNoteRow = {
  id: number;
  title: string;
  content: string | null;
  fileName: string | null;
  fileUrl: string | null;
  fileType: "text" | "pdf" | "image";
  authorName: string;
  authorIsFaculty: boolean;
  facultyVerified: boolean;
  verifiedByName: string | null;
  upvotes: number;
  iVoted: boolean;
  rankScore: number;
  createdAt: string;
};

/**
 * Community notes for a chapter, ranked by the portal formula:
 *   score = upvotes × 0.7 + (faculty-verified ? 30 : 0)
 */
export async function getRankedNotes(
  chapterId: number,
  userId: number,
): Promise<RankedNoteRow[]> {
  const rows = db.all<{
    id: number;
    title: string;
    content: string | null;
    file_name: string | null;
    file_url: string | null;
    file_type: "text" | "pdf" | "image";
    author_name: string;
    author_is_faculty: number | null;
    faculty_verified: number | null;
    verified_by_name: string | null;
    upvotes: number | null;
    i_voted: number | null;
    created_at: number;
  }>(
    sql`
      SELECT
        n.id, n.title, n.content, n.file_name, n.file_url, n.file_type,
        n.author_name,
        (SELECT 1 FROM users u WHERE u.id = n.author_id AND u.role = 'faculty') AS author_is_faculty,
        n.faculty_verified, n.verified_by_name,
        (SELECT COUNT(*) FROM note_votes v WHERE v.note_id = n.id) AS upvotes,
        (SELECT 1 FROM note_votes v WHERE v.note_id = n.id AND v.user_id = ${userId}) AS i_voted,
        n.created_at
      FROM notes n
      WHERE n.chapter_id = ${chapterId}
      ORDER BY n.id DESC
    `,
  );

  return rows
    .map((r) => {
      const upvotes = num(r.upvotes);
      const facultyVerified = r.faculty_verified === 1;
      return {
        id: r.id,
        title: r.title,
        content: r.content,
        fileName: r.file_name,
        fileUrl: r.file_url,
        fileType: r.file_type ?? "text",
        authorName: r.author_name,
        authorIsFaculty: r.author_is_faculty === 1,
        facultyVerified,
        verifiedByName: r.verified_by_name,
        upvotes,
        iVoted: r.i_voted === 1,
        // Ranking Score = Upvotes × 0.7 + (Faculty Verified Badge × 30)
        rankScore: upvotes * 0.7 + (facultyVerified ? 30 : 0),
        createdAt: toIso(r.created_at),
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore || a.id - b.id);
}

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

export type BestAttempt = {
  score: number;
  total: number;
  xpEarned: number;
};

/** The user's best (highest-scoring) objective attempt on a chapter. */
export async function getBestAttempt(
  userId: number,
  chapterId: number,
): Promise<BestAttempt | null> {
  const rows = db.all<{
    score: number;
    total: number;
    xp: number | null;
  }>(
    sql`
      SELECT a.score AS score, a.total AS total,
             (SELECT COALESCE(SUM(x.amount), 0) FROM xp_events x
                WHERE x.user_id = a.user_id AND x.type = 'objective'
                  AND x.ref_type = 'chapter' AND x.ref_id = a.chapter_id) AS xp
      FROM mcq_attempts a
      WHERE a.user_id = ${userId} AND a.chapter_id = ${chapterId}
      ORDER BY a.score DESC, a.id ASC
      LIMIT 1
    `,
  );
  const r = rows[0];
  if (!r) return null;
  return { score: num(r.score), total: num(r.total), xpEarned: num(r.xp) };
}

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

export type ChapterLeaderboardRow = {
  id: number;
  handle: string;
  name: string;
  school: string | null;
  chapterXp: number;
  bestScore: number | null;
  bestTotal: number | null;
  attempts: number;
};

/**
 * Chapter-wise master leaderboard — ranks based solely on objective-test
 * performance in a single chapter (best score first, then chapter XP).
 */
export async function getChapterLeaderboard(
  chapterId: number,
): Promise<ChapterLeaderboardRow[]> {
  const rows = db.all<{
    id: number;
    handle: string;
    name: string;
    school: string | null;
    chapter_xp: number | null;
    best_score: number | null;
    best_total: number | null;
    attempts: number | null;
  }>(
    sql`
      SELECT
        u.id, u.handle, u.name, u.school,
        COALESCE((SELECT SUM(x.amount) FROM xp_events x
                    WHERE x.user_id = u.id AND x.type = 'objective'
                      AND x.ref_type = 'chapter' AND x.ref_id = ${chapterId}), 0) AS chapter_xp,
        MAX(a.score) AS best_score,
        MAX(a.total) AS best_total,
        COUNT(a.id)  AS attempts
      FROM mcq_attempts a
      JOIN users u ON u.id = a.user_id
      WHERE a.chapter_id = ${chapterId}
      GROUP BY u.id
      ORDER BY best_score DESC, chapter_xp DESC, u.name ASC
    `,
  );
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    name: r.name,
    school: r.school,
    chapterXp: num(r.chapter_xp),
    bestScore: r.best_score ?? null,
    bestTotal: r.best_total ?? null,
    attempts: num(r.attempts),
  }));
}

export type ClassLeaderboardRow = {
  id: number;
  handle: string;
  name: string;
  school: string | null;
  state: string | null;
  xp: number;
  accuracy: number | null;
  attempts: number;
  badges: string[];
};

/**
 * Class-wide leaderboard — every learner in the class ranked by total XP.
 * Accuracy is the percentage of correct answers across all objective tests.
 */
export async function getClassLeaderboard(classNo: number): Promise<ClassLeaderboardRow[]> {
  const rows = db.all<{
    id: number;
    handle: string;
    name: string;
    school: string | null;
    state: string | null;
    xp: number | null;
    correct: number | null;
    answered: number | null;
    attempts: number | null;
  }>(
    sql`
      SELECT
        u.id, u.handle, u.name, u.school, u.state,
        COALESCE((SELECT SUM(x.amount) FROM xp_events x WHERE x.user_id = u.id), 0) AS xp,
        COALESCE((SELECT SUM(a.score) FROM mcq_attempts a WHERE a.user_id = u.id), 0) AS correct,
        COALESCE((SELECT SUM(a.total) FROM mcq_attempts a WHERE a.user_id = u.id), 0) AS answered,
        (SELECT COUNT(*) FROM mcq_attempts a WHERE a.user_id = u.id) AS attempts
      FROM users u
      WHERE u.role = 'student' AND u.class_name = ${classNo}
      ORDER BY xp DESC, u.name ASC
    `,
  );

  return rows.map((r) => {
    const correct = num(r.correct);
    const answered = num(r.answered);
    return {
      id: r.id,
      handle: r.handle,
      name: r.name,
      school: r.school,
      state: r.state,
      xp: num(r.xp),
      accuracy: answered > 0 ? Math.round((correct / answered) * 100) : null,
      attempts: num(r.attempts),
      // Badges are attached per user by the route via getBadgesForUser.
      badges: [],
    };
  });
}

// ---------------------------------------------------------------------------
// User stats & badges
// ---------------------------------------------------------------------------

export type UserStats = {
  xp: number;
  rank: number | null;
  accuracy: number | null;
  objectiveAttempts: number;
  notes: number;
  recent: {
    id: number;
    type: string;
    amount: number;
    note: string;
    createdAt: string;
  }[];
};

export async function getUserStats(userId: number, classNo: number): Promise<UserStats> {
  const rows = db.all<{
    xp: number | null;
    rank: number | null;
    correct: number | null;
    answered: number | null;
    attempts: number | null;
    note_count: number | null;
  }>(
    sql`
      SELECT
        COALESCE((SELECT SUM(amount) FROM xp_events WHERE user_id = ${userId}), 0) AS xp,
        (SELECT COUNT(*) + 1 FROM users u2
           WHERE u2.role = 'student' AND u2.class_name = ${classNo}
             AND COALESCE((SELECT SUM(x.amount) FROM xp_events x WHERE x.user_id = u2.id), 0)
                 > COALESCE((SELECT SUM(x.amount) FROM xp_events x WHERE x.user_id = ${userId}), 0)
        ) AS rank,
        COALESCE((SELECT SUM(score) FROM mcq_attempts WHERE user_id = ${userId}), 0) AS correct,
        COALESCE((SELECT SUM(total) FROM mcq_attempts WHERE user_id = ${userId}), 0) AS answered,
        (SELECT COUNT(*) FROM mcq_attempts WHERE user_id = ${userId}) AS attempts,
        (SELECT COUNT(*) FROM notes WHERE author_id = ${userId}) AS note_count
    `,
  );

  const s = rows[0];
  const xp = num(s?.xp);
  const correct = num(s?.correct);
  const answered = num(s?.answered);

  const recentRows = db.all<{
    id: number;
    type: string;
    amount: number;
    note: string;
    created_at: number;
  }>(
    sql`
      SELECT id, type, amount, note, created_at
      FROM xp_events
      WHERE user_id = ${userId}
      ORDER BY created_at DESC, id DESC
      LIMIT 5
    `,
  );

  return {
    xp,
    rank: typeof s?.rank === "number" && s.rank >= 1 ? s.rank : null,
    accuracy: answered > 0 ? Math.round((correct / answered) * 100) : null,
    objectiveAttempts: num(s?.attempts),
    notes: num(s?.note_count),
    recent: recentRows.map((r) => ({
      id: r.id,
      type: r.type,
      amount: num(r.amount),
      note: r.note,
      createdAt: toIso(r.created_at),
    })),
  };
}

/** Badge ids earned by a user, derived from their activity. */
export async function getBadgesForUser(userId: number): Promise<string[]> {
  const earned = new Set<string>();

  const agg = db.all<{
    mcq_attempts: number | null;
    best_pct: number | null;
    science_correct: number | null;
    chapters_practiced: number | null;
    hot_notes: number | null;
  }>(
    sql`
      SELECT
        (SELECT COUNT(*) FROM mcq_attempts WHERE user_id = ${userId}) AS mcq_attempts,
        (SELECT MAX(ROUND(100.0 * score / NULLIF(total, 0)))
           FROM mcq_attempts WHERE user_id = ${userId}) AS best_pct,
        (SELECT COALESCE(SUM(a.score), 0) FROM mcq_attempts a
           JOIN chapters c ON c.id = a.chapter_id
           WHERE a.user_id = ${userId} AND c.subject_slug = 'science') AS science_correct,
        (SELECT COUNT(DISTINCT chapter_id) FROM (
           SELECT chapter_id FROM mcq_attempts WHERE user_id = ${userId}
           UNION
           SELECT chapter_id FROM subjective_attempts WHERE user_id = ${userId}
         )) AS chapters_practiced,
        (SELECT COUNT(*) FROM notes n
           WHERE n.author_id = ${userId}
             AND (SELECT COUNT(*) FROM note_votes v WHERE v.note_id = n.id) >= 10) AS hot_notes
    `,
  );

  const a = agg[0];
  if (num(a?.mcq_attempts) > 0) earned.add("first_steps");
  if (num(a?.best_pct) >= 90) earned.add("quiz_whiz");
  if (num(a?.science_correct) >= 15) earned.add("science_scholar");
  if (num(a?.chapters_practiced) >= 3) earned.add("multi_chapter");
  if (num(a?.hot_notes) > 0) earned.add("top_contributor");

  return [...earned];
}
