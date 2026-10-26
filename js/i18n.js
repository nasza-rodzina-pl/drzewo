// family-chart ma wbudowane angielskie napisy w formularzach — tłumaczymy je w locie.
const DICT = {
  'Cancel': 'Anuluj',
  'Submit': 'Zatwierdź',
  'Delete': 'Usuń osobę',
  'Remove Relation': 'Usuń powiązanie',
  'Cancel Remove Relation': 'Anuluj usuwanie powiązania',
  'Gender': 'Płeć',
  'Male': 'Mężczyzna',
  'Female': 'Kobieta',
  'UNKNOWN': 'Nieznany',
  'Unknown': 'Nieznany',
  'Search': 'Szukaj',
  'Select profile': 'Wybierz osobę',
  'Are you sure you want to delete this profile?': 'Na pewno usunąć tę osobę?',
  'Yes': 'Tak',
  'Accept': 'Potwierdź',
  'You are removing a spouse relationship. Since there are shared children, please choose which parent should keep them in the family tree.':
    'Usuwasz związek małżeński. Para ma wspólne dzieci — wybierz, przy którym rodzicu mają pozostać w drzewie.',
  'Keep children with current person': 'Dzieci zostają przy tej osobie',
  'Keep children with spouse': 'Dzieci zostają przy małżonku',
  'No': 'Nie',
  'This profile is not connected to the main profile': 'Ta osoba nie jest połączona z osobą główną',
};

function translateNode(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.nodeValue.trim();
    if (t && DICT[t]) n.nodeValue = n.nodeValue.replace(t, DICT[t]);
  }
  if (root.querySelectorAll) {
    for (const e of root.querySelectorAll('[placeholder],[title]')) {
      for (const a of ['placeholder', 'title']) {
        const v = e.getAttribute(a);
        if (v && DICT[v]) e.setAttribute(a, DICT[v]);
      }
    }
  }
}

export function translateTree(container) {
  translateNode(container);
  new MutationObserver((muts) => {
    for (const m of muts) for (const node of m.addedNodes) {
      if (node.nodeType === 1) translateNode(node);
      else if (node.nodeType === 3 && DICT[node.nodeValue.trim()]) node.nodeValue = DICT[node.nodeValue.trim()];
    }
  }).observe(container, { childList: true, subtree: true });
}
