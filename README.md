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
- Commit ma opis generowany automatycznie („Dodano: …; zmieniono: …”) albo Twój własny, a autorem jest właściciel tokena.

## Uruchomienie

### 1. Repozytorium z danymi (zalecane: prywatne, w organizacji)

Strona na GitHub Pages jest publiczna, ale **dane mogą być w osobnym, prywatnym repozytorium** — kod strony nie zawiera żadnych danych, bez tokena nic nie zobaczysz.

1. Utwórz darmową **organizację** na GitHubie (np. `moja-rodzina`) i w niej prywatne repo, np. `drzewo-dane`, **z plikiem README** (repo nie może być puste).
2. Dodaj członków rodziny do organizacji jako **członków** (nie „outside collaborators” — oni nie mogą używać tokenów fine-grained).

> Dlaczego organizacja? Tokeny *fine-grained* działają tylko dla repozytoriów należących do Ciebie lub do organizacji, w której jesteś. Jako zwykły współpracownik cudzego repo osobistego musiałbyś używać tokena *classic* z zakresem `repo`, który daje dostęp do **wszystkich** Twoich repozytoriów.

### 2. Strona

1. Wrzuć zawartość tego katalogu do repozytorium (może być publiczne, np. `drzewo`).
2. W `config.js` ustaw `owner`, `repo`, `branch`, `dir`.
3. *Settings → Pages → Deploy from a branch → `main` / `/ (root)`*.

Kod może też leżeć w tym samym repo co dane — wtedy dane będą publiczne, jeśli repo jest publiczne.

### 3. Token dla każdej osoby

Każdy tworzy własny token: *Settings → Developer settings → Fine-grained tokens → Generate new token*:

- **Resource owner**: organizacja (np. `moja-rodzina`),
- **Repository access**: *Only select repositories* → `drzewo-dane`,
- **Permissions → Contents: Read and write** (nic więcej nie trzeba).

Właściciel organizacji może musieć zatwierdzić token (*Organization settings → Personal access tokens*). Token wpisuje się przy pierwszym wejściu na stronę; jest przechowywany tylko w przeglądarce (lub tylko do zamknięcia karty, jeśli odznaczysz „Zapamiętaj”).

## Struktura

```
index.html          interfejs
config.js           konfiguracja repozytorium
css/style.css       wygląd
js/app.js           logika strony, zapis, odświeżanie, szkice
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
python3 test/e2e_mock.py          # dwóch użytkowników edytuje równocześnie
```

## Ograniczenia

- Token leży w `localStorage` — nie dodawaj na stronę skryptów z niezaufanych źródeł. Zakres tokena ogranicz do jednego repo.
- Limit API: 5000 zapytań/h na osobę; wczytanie drzewa to ~3 zapytania + 1 na każdy *zmieniony* plik (bloby są cache'owane).
- Przy bardzo dużych drzewach (dziesiątki tysięcy plików) API może obciąć listę plików — wtedy warto przejść na jeden plik zbiorczy.
- Zdjęcia są podawane jako URL; przechowywanie plików graficznych w repo nie jest (jeszcze) obsługiwane.
