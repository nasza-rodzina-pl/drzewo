// Konfiguracja strony — wspólna dla wszystkich użytkowników.
window.FAMILY_TREE_CONFIG = {
  owner: 'nasza-rodzina-pl',  // właściciel repozytorium z danymi (użytkownik lub organizacja)
  repo: 'drzewo-dane',        // repozytorium z danymi (może być prywatne)
  branch: 'main',             // gałąź
  dir: 'people',              // katalog z plikami osób (jeden plik JSON na osobę)
  clientId: 'Iv23liDBRwyMPoEFStTN',               // Client ID aplikacji GitHub (patrz README, „Logowanie przez GitHub”)
  authProxy: 'drzewo-auth.kleswidna.workers.dev',              // adres serwera logowania z auth-worker/, np. https://drzewo-auth.KONTO.workers.dev
  pollSeconds: 30,            // co ile sekund sprawdzać, czy ktoś inny coś zapisał
  title: 'Drzewo genealogiczne',
};
