# DB AutoRun

Run SQL script files and whole folders against SQL Server, Oracle, PostgreSQL or MySQL/MariaDB from one screen. It runs on your own computer. You don't need sqlcmd, SQL*Plus, psql or an Oracle client.

## Start it

Double-click **`start.bat`**. The first start installs the database drivers, which needs internet and can take a few minutes. Your browser then opens the app. Keep the black window open while you use it, and close it to stop the app.

You need [Node.js](https://nodejs.org) version 20 or newer.

## Use it

1. **Choose where the database is:** **This computer** or **Over the internet**. Each choice remembers its own details.
2. **Choose the database type.** The form then appears, with the usual port filled in.
3. **Enter the server, port, user and password**, then click **Connect**.
   - Oracle also needs a **service name**.
   - For SQL Server you can type `server\INSTANCE` or `server,1433`.
4. **Add your scripts** in any of these ways:
   - **Drag and drop** files or folders, including several folders at once.
   - **Press Ctrl+V** to paste files copied in Explorer, or SQL text copied from an editor. Pasted text becomes a script such as `pasted-1.sql`. Click it to check the text before you run it.
   - **Click Paste** to paste SQL text with the mouse. This button can't paste files, so use Ctrl+V for those.
   - **Click Add files or Add folder.** Click **Add folder** again for each extra folder.
5. **Check the order.** Scripts run from top to bottom. Files inside a folder are sorted by number, so `2_x.sql` runs before `10_x.sql`. Use the arrows to change the order.
6. **Choose what happens if a statement fails**, then click **Run**. You are asked to confirm first.
7. **Click any script** to see its results. **Save log** keeps a text copy of them.

If a script fails, fix the file and add it again. It updates in place. Then click **Run the unfinished scripts** so the ones that already worked don't run twice.

## Local and internet databases

| | This computer | Over the internet |
| --- | --- | --- |
| Encryption | On for SQL Server, optional for PostgreSQL and MySQL, not available for Oracle | On by default for all four |
| Certificate check | Off, so self-signed certificates work | On by default, can be turned off |

The screen always shows **Local** or **Internet** next to the server, and the confirmation before a run says which one you are about to change.

For an internet database, the server's firewall also has to allow connections on that port from your IP address. This tool cannot change that.

## How scripts are run

- **Each file gets its own connection**, like running `sqlcmd -i` once per file. `USE`, `SET` options and temp tables do not carry over to the next file.
- **Without a transaction**, statements that ran before a failure stay applied. Oracle commits at the end of each file. A `ROLLBACK` in your script still works.
- **With "Run each file in a transaction"**, a failure rolls that file back. Oracle and MySQL cannot roll back `CREATE`, `ALTER` or `DROP`.
- **A transaction your script opens but never commits** is rolled back when the file ends. On Oracle it is committed, as SQL*Plus does.
- **Stop** takes effect after the current statement finishes.
- **Query results are not shown.** You see row counts, plus `PRINT` and `RAISE NOTICE` messages.
- **File types:** `.sql .ddl .dml .tsql .psql .pgsql .mysql .pls .plb .pks .pkb .prc .fnc .trg .vw`. Other files in a folder are ignored.
- **File encoding** is detected automatically: UTF-8, UTF-16 (the SSMS default) or Windows-1252.

## Client commands

| Database | Handled | Not run, shown as a warning |
| --- | --- | --- |
| SQL Server | `GO`, `GO 5` | `:r`, `:setvar`, `:connect` and other sqlcmd commands |
| Oracle | `;`, `/`, `EXEC`, `EXIT`, and display commands such as `SET`, `SPOOL`, `PROMPT` | `@file`, `START`, `CONNECT`, `DEFINE`, `VARIABLE`, `HOST` |
| PostgreSQL | `$$` bodies, `\set`, `\echo` | `\i`, `\connect`, `\copy` |
| MySQL | `DELIMITER`, `/*! */` | `source` |

A script that includes other files will **not** run those files, so check for warnings.

## Limits

- **PostgreSQL:** `COPY ... FROM stdin` is reported as a failure and its data is skipped. Export with `pg_dump --inserts` instead.
- **Oracle:** version 12.1 or newer. `&variables` are not replaced, and `DBMS_OUTPUT` is not shown. A procedure that compiles with errors shows a warning, not a failure.
- **SQL Server:** SQL logins only, not Windows Authentication.
- **File size:** 500 MB per script.

## Security

- The app only accepts connections from this computer, and refuses requests from other websites.
- Your password is kept in memory only until the app closes. It is never saved to disk or to the browser. The other form fields are remembered for next time.
- **Encrypt the connection** protects against someone reading the traffic. Only **Verify the server's certificate** also proves which server you reached. On Oracle, encryption uses TCPS with the driver's own certificate checks.

## Database logos

The logos in the database dropdown are stored in `public/logos` (`mssql.svg`, `oracle.svg`, `postgres.svg`, `mysql.svg`) and served from there, so the app still needs nothing from the internet. They are shown as images only, so a browser never runs anything inside a logo file. If a file is missing, a plain coloured badge is shown instead.

To change a logo, drop your own `.svg` or `.png` into `public/logos` with the same name and restart.

The included logos come from the [Devicon](https://devicon.dev) icon set (MIT-licensed). The logos themselves are trademarks of their owners. Using them to show which database you are connecting to is normal, but if you distribute this tool publicly, whether to keep them is your decision.

## Usage counts

The app keeps running totals in `data/usage.json`. No database is needed:

```json
{ "users": 12, "runs": 40, "scripts": 310, "since": "2026-11-06" }
```

- **users:** browsers that have run scripts at least once. One person using two browsers, or clearing their browser data, counts more than once.
- **runs:** how many times someone started a run.
- **scripts:** how many script files were sent to run.

Nothing else is stored: no names, IP addresses, server details, passwords or scripts. To see the totals, open the file, go to `/api/usage`, or look at the app's window when it starts. To keep the file somewhere else, set the `DATA_DIR` environment variable.

## Putting it online

This version only accepts requests from the computer it runs on, so it will not work as a public website yet. Don't remove that check to make it work. A public copy would let strangers send database passwords through your server, and let anyone use your server to reach your private network. It first needs HTTPS, a block on private network addresses, rate limits and smaller upload limits.

## Tests

```
npm test
```
