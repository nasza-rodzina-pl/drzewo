// Konfiguracja domyślna. Każdy użytkownik może ją zmienić w oknie logowania
// (zapisywane w przeglądarce), ale zwykle wystarczy ustawić to raz tutaj.
window.FAMILY_TREE_CONFIG = {
  owner: 'moja-rodzina-pl',      // właściciel repozytorium z danymi (użytkownik lub organizacja)
  repo: 'drzewo-dane',        // repozytorium z danymi (może być prywatne)
  branch: 'main',             // gałąź
  dir: 'people',              // katalog z plikami osób (jeden plik JSON na osobę)
  pollSeconds: 30,            // co ile sekund sprawdzać, czy ktoś inny coś zapisał
  title: 'Drzewo genealogiczne',
};
