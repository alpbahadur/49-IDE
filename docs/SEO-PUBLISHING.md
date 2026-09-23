# SEO article publishing connector

The optional connector accepts immutable article publication events from the
SEO tooling service and renders articles on the `49agents.com` website. It uses
a dedicated SQLite database. It never reads or writes the 49Agents user,
session, layout, or terminal database.

## Enable

Set all three required variables on the cloud service and restart it:

```text
SEO_RECEIVER_TOKEN=<secret bearer token shared with the SEO tooling service>
SEO_PUBLIC_ORIGIN=https://49agents.com
SEO_DATABASE_PATH=/var/lib/49agents/seo-publishing.sqlite3
```

`SEO_DATABASE_PATH` must be an absolute path on persistent storage, distinct
from `DATABASE_PATH` and from any symlink or hard-link alias of the user
database. Keep the bearer token in the deployment's secret manager. The
connector is disabled if any required setting is missing or invalid; mounting
the disabled router does not create a database file.

The receiver endpoint is `POST /api/seo/v1/articles`. Event reconciliation is
available at `GET /api/seo/v1/events/{event_id}`. Both require the configured
bearer token. Article pages, the article listing, the sitemap, and the fixed
interactive asset are served only for the exact configured website hostname.
The application hostname does not expose this content.

The protocol supports all 30 SEO block types. Polls, quizzes, and calculators
run entirely in the visitor's browser; their answers are not transmitted or
stored. Forms are accepted only when their HTTPS action origin appears in the
optional comma-separated `SEO_FORM_ACTION_ORIGINS` setting. Without that
allow-list, form blocks are rejected.

Public routes:

- `/articles` lists published articles and links back to the main website.
- `/articles/{slug}` renders a validated article with a canonical URL and
  article ID/revision markers.
- `/sitemap-seo.xml` lists the published canonical URLs.

Article slugs are immutable after the first accepted revision. A later
revision must keep the same slug, so old article URLs remain valid.

## Disable and roll back

Remove `SEO_RECEIVER_TOKEN` (or unset either of the other required variables)
and restart the cloud service. The connector stops accepting publications and
serving its public routes. Its database file is left untouched so a rollback
does not erase published content. To restore service, set the required
variables again and restart.

Retain or back up the dedicated database according to the deployment's normal
persistent-volume policy. Do not point `SEO_DATABASE_PATH` at `DATABASE_PATH`
to migrate data; this connector never modifies the existing user database.
