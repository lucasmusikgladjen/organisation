# API-anrop dokumentation

## Översikt

Applikationen använder Airtable som databas via deras REST API. Alla anrop går genom vår Express-server (`server.js`) som fungerar som proxy mellan klienten och Airtable.

---

## Alla API-endpoints och deras Airtable-anrop

### 1. `GET /api/notes` — Hämta alla anteckningar

**Airtable-anrop:** `GET https://api.airtable.com/v0/{BASE_ID}/{TABLE_ID}`

- Hanterar paginering automatiskt — om det finns fler än 100 poster gör den **flera anrop** (ett per sida) tills alla poster hämtats.
- Körs vid sidladdning.
- **Antal anrop:** 1 per 100 poster (1 anrop om ≤100 poster, 2 om ≤200, osv.)

### 2. `POST /api/notes` — Skapa ny anteckning

**Airtable-anrop:** `POST https://api.airtable.com/v0/{BASE_ID}/{TABLE_ID}`

- Skapar en ny post i Airtable med fälten: Område, Anteckningar, Position X, Position Y, Lösenord.
- Körs när användaren skapar en ny anteckning via formuläret.
- **Antal anrop:** 1 per skapad anteckning

### 3. `PATCH /api/notes/batch` — Batch-uppdatering av positioner

**Airtable-anrop:** `PATCH https://api.airtable.com/v0/{BASE_ID}/{TABLE_ID}`

- Uppdaterar Position X och Position Y för flera anteckningar samtidigt.
- Airtable tillåter max 10 poster per batch, så fler poster delas upp i flera anrop.
- Körs efter 10 sekunders inaktivitet efter att användaren dragit anteckningar, eller vid tab-stängning/byte.
- **Antal anrop:** ⌈N/10⌉ där N = antal flyttade anteckningar

### 4. `PATCH /api/notes/:id` — Uppdatera enskild anteckning

**Airtable-anrop:** `PATCH https://api.airtable.com/v0/{BASE_ID}/{TABLE_ID}`

- Uppdaterar specifika fält (Område eller Anteckningar) för en anteckning.
- Körs 3 sekunder efter att användaren slutat skriva (debounce).
- **Antal anrop:** 1 per anteckning som ändrats

### 5. `POST /api/notes/:id/unlock` — Lås upp lösenordsskyddad anteckning

**Airtable-anrop:** `GET https://api.airtable.com/v0/{BASE_ID}/{TABLE_ID}/{RECORD_ID}`

- Verifierar lösenordet server-side och hämtar sedan den faktiska anteckningstexten från Airtable.
- Körs när användaren klickar på en låst anteckning och anger rätt lösenord.
- **Antal anrop:** 1 per upplåsning

### 6. `DELETE /api/notes/:id` — Radera anteckning

**Airtable-anrop:** `DELETE https://api.airtable.com/v0/{BASE_ID}/{TABLE_ID}/{RECORD_ID}`

- Verifierar lösenordet först, sedan raderar posten i Airtable.
- **Antal anrop:** 1 per radering

### 7. `POST /api/verify-password` — Verifiera lösenord

**Airtable-anrop:** Inga — kontrollerar enbart mot `NOTE_PASSWORD` i miljövariabler.

- **Antal anrop:** 0

---

## Sammanfattning av anrop per användaråtgärd

| Åtgärd | Airtable-anrop |
|--------|----------------|
| Ladda sidan | 1+ (paginering) |
| Skapa ny anteckning | 1 |
| Redigera titel/text | 1 per fält (debounced 3s) |
| Flytta anteckningar | ⌈N/10⌉ (batched efter 10s) |
| Lås upp anteckning | 1 |
| Radera anteckning | 1 |
| Byta tab / stänga sidan | ⌈N/10⌉ + M (positions + content) |

---

## Förslag för att minska antalet API-anrop

### 1. Batcha innehållsuppdateringar

**Nuvarande:** Varje antecknings titel/text sparas individuellt (`PATCH /api/notes/:id`), ett anrop per anteckning.

**Förbättring:** Samla ihop alla innehållsändringar och skicka dem som en batch-uppdatering precis som positionsuppdateringar redan gör. Airtable tillåter batch-PATCH med upp till 10 poster åt gången.

**Besparing:** Om man redigerar 5 anteckningar på 3 sekunder: 5 anrop → 1 anrop.

### 2. Kombinera positions- och innehållssparning

**Nuvarande:** Positioner och innehåll sparas i separata API-anrop med olika timers (10s vs 3s).

**Förbättring:** Kombinera till ett enda batch-anrop som inkluderar både positions- och innehållsförändringar. Skicka alla dirty fields i samma `PATCH`-anrop per post.

**Besparing:** Halverar potentiellt antalet anrop vid samtidiga ändringar.

### 3. Caching med ETag / If-Modified-Since

**Nuvarande:** Varje sidladdning hämtar alla poster från Airtable, även om inget ändrats.

**Förbättring:** Spara en tidsstämpel eller hash av senaste hämtningen. Använd Airtables `filterByFormula` med `LAST_MODIFIED_TIME()` för att bara hämta poster som ändrats sedan senaste synkroniseringen.

**Besparing:** Minskar datamängd och kan undvika paginering helt vid små ändringar.

### 4. Debounce-optimering

**Nuvarande:** Titeln debounce-sparas var 3:e sekund per tangenttryckning-paus.

**Förbättring:** Öka debounce-tiden till 5-10 sekunder, eller spara enbart vid blur (när användaren klickar utanför fältet). De flesta användare skriver klart en titel i en session.

**Besparing:** Färre onödiga sparningar medan användaren fortfarande skriver.

### 5. Undvik dubbel laddning vid sidstart

**Nuvarande:** Appen laddar från cache OCH hämtar från servern direkt vid start, vilket alltid ger minst 1 API-anrop.

**Förbättring:** Kolla cache-ålder. Om cachen är färskare än t.ex. 30 sekunder, vänta med att synka från servern (eller vänta tills användaren trycker "spara" / en timer löper ut).

**Besparing:** 1 anrop per sidladdning om cachen är tillräckligt färsk.

### 6. WebSocket / Server-Sent Events istället för polling

**Nuvarande:** Appen gör inga realtidsuppdateringar — data hämtas bara vid sidladdning.

**Förbättring:** Om flera användare ska kunna samarbeta, använd en WebSocket-anslutning som pushar ändringar istället för att varje klient pollar. (Kräver dock en annan backend-arkitektur.)

**Besparing:** Eliminerar behovet av periodiska hämtningar helt.

### 7. Lokal-först med synkronisering i bakgrunden

**Nuvarande:** Varje ändring skickas till Airtable direkt (med debounce).

**Förbättring:** Arbeta helt lokalt (localStorage) och synkronisera med Airtable med ett enda batch-anrop med jämna mellanrum (t.ex. var 30:e sekund eller vid tab-stängning).

**Besparing:** Drastisk minskning — från potentiellt dussintals anrop per session till ett fåtal.
