# Drzewo genealogiczne na GitHub Pages

Statyczna strona z interaktywnym drzewem ([family-chart](https://github.com/donatso/family-chart)), która czyta i zapisuje dane bezpośrednio w repozytorium GitHuba. Kilka osób może edytować jednocześnie — zmiany są scalane automatycznie.

## Jak to działa

- **Dane**: jeden plik JSON na osobę w katalogu `people/` repozytorium z danymi (format family-chart: `id`, `data`, `rels.parents/spouses/children`). Pliki mają posortowane klucze, więc diffy i `git blame` są czytelne.
- **Zapis**: przycisk *Zapisz* (lub Ctrl+S) tworzy **jeden atomowy commit** przez Git Data API. Gałąź jest przesuwana bez `force`, więc nie da się nadpisać cudzej pracy.
- **Równoczesna edycja**: jeśli ktoś zapisał w międzyczasie, strona pobiera najnowszy stan, robi **scalanie 3-stronne per osoba i per pole** i ponawia zapis:
  - różne osoby lub różne pola tej samej osoby → łączone bez strat,
  - relacje (rodzice, małżonkowie, dzieci) → łączone jak zbiory,
  - to samo pole zmienione przez obie strony → wygrywa wersja zapisującego, a strona wyświetla ostrzeżenie (poprzednia wartość zostaje w historii gita),
  - usunięcie osoby, którą ktoś inny w tym czasie edytował → osoba zostaje.
- **Odświeżanie**: co 30 s strona sprawdza, czy w repo pojawił się nowy commit (zapytanie z ETag, nie zużywa limitu API). Bez lokalnych zmian — wczytuje je od razu; z lokalnymi zmianami — pokazuje baner „Scal teraz”.
- **Szkic**: niezapisane zmiany są trzymane w `localStorage`, więc zamknięcie karty ich nie gubi.
- Commit ma opis generowany automatycznie („Dodano: …; zmieniono: …”) albo Twój własny, a autorem jest zalogowana osoba.

## Uruchomienie

### 1. Repozytorium z danymi (zalecane: prywatne)

Strona na GitHub Pages jest publiczna, ale **dane mogą być w osobnym, prywatnym repozytorium** — kod strony nie zawiera żadnych danych, bez zalogowania nic nie widać.

1. Utwórz prywatne repo, np. `drzewo-dane`, **z plikiem README** (repo nie może być puste).
2. Zaproś członków rodziny: *Settings → Collaborators → Add people*. Dostęp do drzewa ma dokładnie ten, kto ma dostęp do tego repo.

### 2. Strona

1. Wrzuć zawartość tego katalogu do repozytorium (może być publiczne, np. `drzewo`).
2. W `config.js` ustaw `owner`, `repo`, `branch`, `dir` (oraz `clientId` i `authProxy` z kroku 3).
3. *Settings → Pages → Deploy from a branch → `main` / `/ (root)`*.

### 3. Logowanie przez GitHub (robi się raz)

Użytkownicy logują się kontem GitHub — nikt nie tworzy tokenów. Potrzebne są dwie rzeczy:

**a) Aplikacja GitHub** — *Settings → Developer settings → GitHub Apps → New GitHub App* (na koncie właściciela repo z danymi):

- **GitHub App name**: dowolna, np. `Drzewo nasza-rodzina`,
- **Homepage URL** i **Callback URL** (na niektórych ekranach: **Redirect URI**): adres strony, np. `https://nasza-rodzina-pl.github.io/drzewo/` (dokładnie, ze `/` na końcu),
- **Expire user authorization tokens**: jeśli ta opcja jest dostępna, zaznacz ją (token ważny 8 h, odświeżany automatycznie); jeśli jej nie ma, nic nie szkodzi — strona obsługuje też tokeny bez terminu ważności,
- **Webhook → Active**: odznacz,
- **Repository permissions → Contents: Read and write** (Metadata: Read-only dodaje się samo), nic więcej,
- **Where can this GitHub App be installed?**: *Any account* (aplikacja publiczna). Przy *Only on this account* zalogować może się tylko właściciel — inni dostają na GitHubie błąd 404. Publiczna aplikacja nie daje nikomu dostępu do danych: działa tylko na repozytoriach, na których ją zainstalowano, i tylko dla osób, które mają do nich dostęp. Ustawienie można zmienić później w *Advanced → Make public*.

Po utworzeniu skopiuj **Client ID** i wygeneruj **Client secret** (*Generate a new client secret*). Potem *Install App* → zainstaluj na swoim koncie → *Only select repositories* → `drzewo-dane`.

Aplikacja działa w imieniu zalogowanej osoby, ale tylko w obrębie `drzewo-dane` — nie widzi innych repozytoriów użytkownika. Commity mają jako autora tę osobę.

**b) Serwer logowania** (`auth-worker/`) — GitHub nie pozwala wymienić kodu logowania na token bezpośrednio z przeglądarki i wymaga do tego sekretu, więc robi to mały, darmowy Cloudflare Worker:

1. Załóż konto na [dash.cloudflare.com](https://dash.cloudflare.com) (plan Free wystarczy).
2. *Workers & Pages → Create → Start with Hello World* → nazwa np. `drzewo-auth` → *Deploy* → *Edit code*, wklej zawartość `auth-worker/worker.js`, *Deploy*.
3. *Settings → Variables and secrets* dodaj:
   - `CLIENT_ID` (Text) — Client ID aplikacji,
   - `CLIENT_SECRET` (**Secret**) — Client secret aplikacji,
   - `ALLOWED_ORIGIN` (Text) — `https://nasza-rodzina-pl.github.io`.
4. Adres workera (np. `https://drzewo-auth.KONTO.workers.dev`) wpisz w `config.js` jako `authProxy`, a Client ID jako `clientId`.

Alternatywnie z wiersza poleceń: `cd auth-worker && npx wrangler deploy`, potem `npx wrangler secret put CLIENT_ID` i `npx wrangler secret put CLIENT_SECRET`.

Przy pierwszym logowaniu każda osoba zobaczy na GitHubie prośbę o autoryzację aplikacji. Jeśli konto nie ma dostępu do `drzewo-dane`, strona to wyświetli.

## Struktura

```
index.html          interfejs
config.js           konfiguracja repozytorium i logowania
auth-worker/        serwer logowania (Cloudflare Worker)
css/style.css       wygląd
js/app.js           logika strony, zapis, odświeżanie, szkice
js/auth.js          logowanie przez GitHub (OAuth z PKCE, odświeżanie tokena)
js/github.js        GitHub API (odczyt drzewa plików, atomowe commity)
js/merge.js         normalizacja, diff i scalanie 3-stronne (bez zależności)
js/i18n.js          polskie napisy w formularzach family-chart
vendor/             family-chart 0.9.0 i d3 7.9.0 (licencje obok)
test/               testy scalania (Node) i test e2e z atrapą GitHub API (Playwright)
```

Pola osoby (imię, nazwisko, nazwisko rodowe, daty, miejsce urodzenia, zdjęcie, notatki) definiuje tablica `FIELDS` w `js/app.js` — możesz dopisać własne.

## Testy

```bash
node --test test/merge.test.mjs
pip install playwright && python -m playwright install chromium
python3 test/e2e_mock.py          # logowanie + dwóch użytkowników edytuje równocześnie
```

## Ograniczenia

- Token logowania leży w `localStorage` — nie dodawaj na stronę skryptów z niezaufanych źródeł. Działa tylko dla repozytoriów, na których zainstalowano aplikację, i zwykle wygasa po 8 h (odświeżany automatycznie).
- Limit API: 5000 zapytań/h na osobę; wczytanie drzewa to ~3 zapytania + 1 na każdy *zmieniony* plik (bloby są cache'owane).
- Przy bardzo dużych drzewach (dziesiątki tysięcy plików) API może obciąć listę plików — wtedy warto przejść na jeden plik zbiorczy.
- Zdjęcia są podawane jako URL; przechowywanie plików graficznych w repo nie jest (jeszcze) obsługiwane.
