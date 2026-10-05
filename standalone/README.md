# Standalone exam and catalog seed

This one-off utility is intentionally separate from the API startup and is not added to `package.json` scripts. It adds active MCQs until every existing course has at least 100, then creates at least 20 published practice exams with 20 questions each. It reuses the courses, assigned teachers, and active admin/operator accounts already in the database.

Supported subject names are Physics, Chemistry, Mathematics, Biology, Computer Science, Information Technology, Programming, and English. It stops before writing if a course uses an unsupported subject or has no eligible owner.

From the `server` directory:

```sh
node standalone/seed-exams-and-catalog.mjs
node standalone/seed-exams-and-catalog.mjs --apply
```

Preview is the default; `--dry-run` is also accepted explicitly. Database writes require `--apply`. The script is idempotent for its generated question text and exam titles. It does not delete or change existing questions, exams, attempts, users, classes, subjects, or courses. If `NODE_ENV=production`, writes also require `--allow-production`. Do not run two copies at the same time.
