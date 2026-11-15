# FF-Planner – Terminplanung

Modul des Portals **FrankenFinals Broadcast** ([FrizBok/FF-Broadcast-Portal](https://github.com/FrizBok/FF-Broadcast-Portal)):
Termine freigeben, Verfügbarkeit abfragen, die Crew auf Stellen einteilen und offene Stellen zeigen. Optional mit
Rundown aus [FF Rundown](https://github.com/Intracy/FF-Rundown).

Node.js ≥ 22.13, eingebautes SQLite, keine Fremdpakete. Läuft als eigener Dienst neben dem Portal; angemeldet wird
ausschließlich über die Kachel im Portal (Single Sign-on).

## Ablauf

1. **Termin anlegen** (Planer): Titel, Datum, Treffen/Beginn/Ende, Ort, Beschreibung, optional Rückmeldefrist und die
   **Stellen** (z. B. 1× Regie, 3× Kamera, 1× Ton – aus der Stellen-Liste oder frei benannt). Als Entwurf oder gleich freigeben.
2. **Freigeben** → alle Mitglieder sehen den Termin und tragen ein:
   **Vor Ort** (grün) · **Später** mit Uhrzeit „ab wann“ (orange) · **Online** (blau) · **Kann nicht** (rot) –
   jeweils mit Kommentar, außer bei „Kann nicht“ optional mit Wunsch-Stellen („würde gern Kamera machen“).
3. **Besetzung** (Planer): Personen auf Stellen einteilen. Die Auswahl sortiert nach Rückmeldung, zeigt Wünsche (★),
   Kommentare und wer schon anderswo eingeteilt ist. Planer können auch für andere eintragen (z. B. Absage per Telefon).
4. **Offene Stellen** sind überall markiert und auf einer eigenen Seite gesammelt – dort können Mitglieder Interesse melden.
5. **Abfrage beenden** → nur noch Planer ändern Rückmeldungen. Termine lassen sich absagen, kopieren und als `.ics` in den Kalender laden.

Weitere Seiten: **Meine Einsätze**, **Verwaltung** (Personen aus dem Portal, Stellen-Liste).

**Live-Aktualisierung:** Alle offenen Browser bekommen Änderungen sofort angezeigt (Rückmeldungen, Einteilungen, neue oder
geänderte Termine, Stellen-Liste, Personen) – ohne Neuladen. Technik: Server-Sent Events unter `/api/live`; gemeldet wird
nur *was* sich geändert hat, die Seite lädt dann mit den eigenen Rechten nach. Während jemand tippt oder ein Dialog offen ist,
wartet die Aktualisierung bis danach. Die Anzeige „Live“ oben zeigt, ob die Verbindung steht. Hinter Nginx Proxy Manager ist
nichts einzustellen (der Server schickt `X-Accel-Buffering: no` und hält die Verbindung mit einem Ping offen).

## Rollen (vergeben im Portal unter Benutzer → Module → Terminplanung)

| Rolle | Darf |
|---|---|
| Mitglied | freigegebene Termine sehen, eigene Rückmeldung, Besetzung und Rückmeldungen ansehen |
| Planer | Termine anlegen, bearbeiten, freigeben, absagen, Entwürfe löschen, einteilen, für andere eintragen, Rundown hinterlegen |
| Planer-Admin | zusätzlich Stellen-Liste verwalten und freigegebene Termine endgültig löschen |

Plattform-Admins sind automatisch Planer-Admin. **Gäste** (Portal) mit Rolle Mitglied sehen nur Termine, für die sie eingeteilt sind.

## Einrichtung

| Terminplanung | Portal |
|---|---|
| `PORTAL_URL=https://portal.example.de` | `PLANNER_URL=https://planner.example.de` |
| `PORTAL_SSO_SECRET=<schlüssel>` | `PLANNER_SSO_SECRET=<schlüssel>` |

Optional mit FF Rundown:

| Terminplanung | FF Rundown |
|---|---|
| `RUNDOWN_URL=https://rundown.example.de` | – |
| `RUNDOWN_API_SECRET=<schlüssel2>` | `PLANNER_API_SECRET=<schlüssel2>` |

Schlüssel erzeugen: `openssl rand -hex 32`. Alle Variablen: siehe `.env.example`.

```bash
docker compose up -d --build     # oder: npm start
```

Hinter Nginx Proxy Manager: `TRUST_PROXY=true`, eigene Subdomain (z. B. `planner.fl-tecmedia.de`).

### Mitgliederliste

Mit `PORTAL_URL` + `PORTAL_SSO_SECRET` holt sich die Terminplanung beim Start und alle 10 Minuten
(`DIRECTORY_SYNC_MINUTES`) die Personen mit Zugriff aus dem Portal (`GET /api/modules/planner/directory`, mit dem
Schlüssel unterschrieben). So können Planer auch Leute einteilen, die das Modul noch nie geöffnet haben. Wer im Portal
den Zugriff verliert, wird hier inaktiv und abgemeldet; Einteilungen bleiben zur Nachvollziehbarkeit sichtbar.
Unter *Verwaltung* gibt es „Jetzt abgleichen“.

### Rundown

Mit `RUNDOWN_URL` + `RUNDOWN_API_SECRET` können Planer zu einem Termin einen Rundown **auswählen** oder **neu anlegen**
(mit Datum und Startzeit des Termins). Dabei gelten die Rechte aus FF Rundown: Man sieht nur Rundowns, die man dort sieht,
und anlegen darf nur, wer dort Editor ist. Die Person muss FF Rundown dafür einmal über das Portal geöffnet haben.
Der Link öffnet den Rundown über das Portal (`/sso/rundown?next=/#/rundown/<id>`) und ist nur für Personen mit dem
Modul „FF Rundown“ sichtbar.

## Entwicklung

```bash
npm run dev    # mit automatischem Neustart
npm test       # Ende-zu-Ende-Tests (mit Ersatz für Portal und FF Rundown)
```

Daten liegen in `data/planner.db` (Ordner `data` beim Update behalten).
