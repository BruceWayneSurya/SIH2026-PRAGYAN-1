import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { db } from "../db";
import { chapters, notes, noteVotes, xpEvents } from "../db/schema";
import { and, count, eq } from "drizzle-orm";
import { getActiveUser } from "../auth/session";
import { getRankedNotes } from "../data/queries";

const router = Router();

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
      cb(null, `n${Date.now()}-${safeName}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
});

/** GET /api/notes?chapterId= — ranked community notes for a chapter. */
router.get("/", async (req, res) => {
  const user = await getActiveUser(req);
  if (!user) return res.status(401).json({ error: "Please log in first." });
  const chapterId = Number(req.query.chapterId);
  if (!Number.isInteger(chapterId) || chapterId <= 0)
    return res.status(400).json({ error: "Missing chapter." });
  const list = await getRankedNotes(chapterId, user.id);
  return res.json({ list });
});

/** POST /api/notes — multipart form (chapterId, title, content?, file?) */
router.post("/", upload.single("file"), async (req, res) => {
  const user = await getActiveUser(req);
  if (!user) return res.status(401).json({ error: "Please log in first." });

  const chapterId = Number(req.body.chapterId);
  const title = String(req.body.title ?? "").trim();
  const content = String(req.body.content ?? "").trim();

  if (!Number.isInteger(chapterId) || chapterId <= 0)
    return res.status(400).json({ error: "Missing chapter." });
  if (title.length < 4)
    return res
      .status(400)
      .json({ error: "Please give your notes a title (min 4 characters)." });

  let fileType: "text" | "pdf" | "image" = "text";
  let fileUrl: string | null = null;
  let fileName: string | null = null;

  // Validate that the target chapter exists (FK errors are otherwise opaque).
  const [chapter] = await db
    .select({ id: chapters.id })
    .from(chapters)
    .where(eq(chapters.id, chapterId))
    .limit(1);
  if (!chapter) return res.status(404).json({ error: "Chapter not found." });

  try {
    if (req.file) {
      fileName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
      const lower = fileName.toLowerCase();
      if (lower.endsWith(".pdf")) fileType = "pdf";
      else if (/\.(png|jpe?g|webp)$/.test(lower)) fileType = "image";
      else {
        fs.unlinkSync(req.file.path);
        return res
          .status(400)
          .json({ error: "Only PDF and image files can be uploaded." });
      }
      fileUrl = `/uploads/${path.basename(req.file.path)}`;
    } else if (!content) {
      return res
        .status(400)
        .json({ error: "Add some content or attach a PDF / image file." });
    }

    const [row] = await db
      .insert(notes)
      .values({
        chapterId,
        title,
        content: content || null,
        fileName,
        fileUrl,
        fileType,
        authorId: user.id,
        authorName: user.name,
      })
      .returning({ id: notes.id });

    return res.json({ ok: true, id: row.id });
  } catch (err) {
    if (req.file) fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path);
    console.error("[notes] create failed", err);
    return res.status(500).json({ error: "Could not save your notes. Please try again." });
  }
});

/** POST /api/notes/:id/vote */
router.post("/:id/vote", async (req, res) => {
  const user = await getActiveUser(req);
  if (!user) return res.status(401).json({ error: "Please log in first." });

  const noteId = Number(req.params.id);
  if (!Number.isInteger(noteId))
    return res.status(400).json({ error: "Invalid note." });

  try {
    const [note] = await db.select().from(notes).where(eq(notes.id, noteId)).limit(1);
    if (!note) return res.status(404).json({ error: "Note not found." });

    const [existing] = await db
      .select({ id: noteVotes.id })
      .from(noteVotes)
      .where(and(eq(noteVotes.noteId, noteId), eq(noteVotes.userId, user.id)))
      .limit(1);

    let voted: boolean;
    if (existing) {
      await db.delete(noteVotes).where(eq(noteVotes.id, existing.id));
      voted = false;
    } else {
      await db
        .insert(noteVotes)
        .values({ noteId, userId: user.id })
        .onConflictDoNothing();
      voted = true;
    }

    const [c] = await db
      .select({ n: count() })
      .from(noteVotes)
      .where(eq(noteVotes.noteId, noteId));
    const upvotes = c.n;

    let reward = 0;
    if (voted && upvotes >= 10 && !note.rewarded && note.authorId) {
      await db.update(notes).set({ rewarded: true }).where(eq(notes.id, noteId));
      await db.insert(xpEvents).values({
        userId: note.authorId,
        type: "note_upvotes",
        amount: 50,
        refType: "note",
        refId: noteId,
        note: `Note reached 10+ upvotes — "${note.title}"`,
      });
      reward = 50;
    }

    return res.json({ ok: true, upvotes, voted, reward });
  } catch (err) {
    console.error("[notes] vote failed", err);
    return res.status(500).json({ error: "Could not record your vote. Please try again." });
  }
});

/** POST /api/notes/:id/verify — faculty only */
router.post("/:id/verify", async (req, res) => {
  const user = await getActiveUser(req);
  if (!user) return res.status(401).json({ error: "Please log in first." });
  if (user.role !== "faculty")
    return res.status(403).json({ error: "Only faculty members can verify notes." });

  const noteId = Number(req.params.id);
  if (!Number.isInteger(noteId) || noteId <= 0)
    return res.status(400).json({ error: "Invalid note." });
  const verified = !!(req.body as { verified?: boolean } | undefined)?.verified;

  try {
    const [row] = await db
      .update(notes)
      .set({
        facultyVerified: verified,
        verifiedByName: verified ? user.name : null,
      })
      .where(eq(notes.id, noteId))
      .returning({ id: notes.id });

    if (!row) return res.status(404).json({ error: "Note not found." });
    return res.json({ ok: true, facultyVerified: verified });
  } catch (err) {
    console.error("[notes] verify failed", err);
    return res.status(500).json({ error: "Could not update the note. Please try again." });
  }
});

export default router;
