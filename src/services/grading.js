import { sql } from '../db/connection.js';

export const gradeForPercentage = (pct) => {
    if (pct >= 80) return 'A+';
    if (pct >= 70) return 'A';
    if (pct >= 60) return 'B';
    if (pct >= 50) return 'C';
    if (pct >= 40) return 'D';
    return 'F';
};

// Deterministic PRNG so a student's question/option order is identical on resume (EXM-4).
const mulberry32 = (seed) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const seededShuffle = (items, seed) => {
    const rand = mulberry32(seed);
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

/** RES-3: Immediate | After test window closes | Manual release. */
export const resultsVisible = (test, now = new Date()) => {
    if (test.result_mode === 2) return test.status === 3 || now >= new Date(test.end_at);
    if (test.result_mode === 3) return test.results_released === true;
    return true;
};

export const describeAttempt = (attempt, test, questionCount) => {
    const maxMarks = questionCount * parseFloat(test.mark_per_q || 1);
    const score = attempt.score !== null && attempt.score !== undefined ? parseFloat(attempt.score) : null;
    const percentage = score !== null && maxMarks > 0 ? Math.round((score / maxMarks) * 100) : null;
    return {
        id: attempt.id,
        testId: attempt.test_id,
        studentId: attempt.student_id,
        score,
        percentage,
        grade: percentage !== null ? gradeForPercentage(percentage) : null,
        correctCnt: attempt.correct_cnt,
        wrongCnt: attempt.wrong_cnt,
        unansweredCnt: attempt.submitted_at ? questionCount - (attempt.correct_cnt || 0) - (attempt.wrong_cnt || 0) : null,
        submittedAt: attempt.submitted_at,
    };
};

/**
 * Grades and closes an attempt exactly once. Safe to call from the submit endpoint AND the auto-submit job
 * at the same time: the UPDATE only succeeds while submitted_at IS NULL, otherwise the stored result is returned.
 */
export const finalizeAttempt = async (attemptId, requestedAt = new Date()) => {
    const [attempt] = await sql`SELECT * FROM attempts WHERE id = ${attemptId}`;
    if (!attempt) return null;
    const [test] = await sql`SELECT * FROM tests WHERE id = ${attempt.test_id}`;

    const questions = await sql`
    SELECT q.id, q.correct FROM questions q
    JOIN test_questions tq ON tq.question_id = q.id WHERE tq.test_id = ${attempt.test_id}
  `;

    if (attempt.submitted_at) return { attempt, test, questionCount: questions.length, alreadySubmitted: true };

    const answers = await sql`SELECT question_id, chosen FROM attempt_answers WHERE attempt_id = ${attemptId}`;
    const chosenBy = new Map(answers.map((a) => [a.question_id, a.chosen]));

    let correctCnt = 0;
    let wrongCnt = 0;
    for (const q of questions) {
        const chosen = chosenBy.get(q.id);
        if (!chosen) continue;
        if (chosen === q.correct) correctCnt++;
        else wrongCnt++;
    }

    const raw = correctCnt * parseFloat(test.mark_per_q) - wrongCnt * parseFloat(test.neg_mark);
    const score = Math.max(0, Math.round(raw * 100) / 100);
    // Never stamp a submit time later than the server deadline.
    const submittedAt = new Date(Math.min(requestedAt.getTime(), new Date(attempt.deadline_at).getTime()));

    const [updated] = await sql`
    UPDATE attempts
    SET submitted_at = ${submittedAt.toISOString()}, correct_cnt = ${correctCnt}, wrong_cnt = ${wrongCnt}, score = ${score}
    WHERE id = ${attemptId} AND submitted_at IS NULL
    RETURNING *
  `;
    if (updated) return { attempt: updated, test, questionCount: questions.length, alreadySubmitted: false };

    const [current] = await sql`SELECT * FROM attempts WHERE id = ${attemptId}`;
    return { attempt: current, test, questionCount: questions.length, alreadySubmitted: true };
};