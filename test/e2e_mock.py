"""Test end-to-end: dwie osoby edytują równocześnie, GitHub API zastąpione atrapą w pamięci.

Uruchom z katalogu projektu:  python3 test/e2e_mock.py
"""
import base64, hashlib, http.server, json, os, re, sys, threading, time
from functools import partial
from urllib.parse import parse_qs, urlencode, urlparse
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp'


class FakeGit:
    """Minimalna atrapa Git Data API: commity to pełne słowniki ścieżka -> treść."""

    def __init__(self, files):
        self.objects = {}  # sha -> ('commit', {...}) | ('tree', {...}) | ('blob', str)
        self.head = self._commit(files, [], 'init')
        self.commits_log = []

    def _sha(self, kind, payload):
        return hashlib.sha1((kind + json.dumps(payload, sort_keys=True)).encode()).hexdigest()

    def _tree(self, files):
        for c in files.values():
            self.objects.setdefault(self._sha('blob', c), ('blob', c))
        sha = self._sha('tree', files)
        self.objects[sha] = ('tree', dict(files))
        return sha

    def _commit(self, files, parents, msg):
        t = self._tree(files)
        payload = {'tree': t, 'parents': parents, 'msg': msg, 'n': len(self.objects)}
        sha = self._sha('commit', payload)
        self.objects[sha] = ('commit', payload)
        return sha

    def files_at(self, commit_sha):
        return self.objects[self.objects[commit_sha][1]['tree']][1]

    def handle(self, method, path, body):
        m = re.match(r'^/repos/o/r(/.*)$', path.split('?')[0])
        if path == '/user':
            return 200, {'login': 'tester', 'avatar_url': 'data:image/gif;base64,R0lGODlhAQABAAAAACw='}
        if not m:
            return 404, {'message': 'Not Found'}
        p = m.group(1)
        if method == 'GET' and p == '/git/ref/heads/main':
            return 200, {'object': {'sha': self.head}}
        if method == 'GET' and p.startswith('/git/commits/'):
            c = self.objects[p.rsplit('/', 1)[1]][1]
            return 200, {'sha': p.rsplit('/', 1)[1], 'tree': {'sha': c['tree']}}
        if method == 'GET' and p.startswith('/git/trees/'):
            files = self.objects[p.rsplit('/', 1)[1]][1]
            return 200, {'truncated': False, 'tree': [
                {'path': k, 'type': 'blob', 'sha': self._sha('blob', v)} for k, v in files.items()]}
        if method == 'GET' and p.startswith('/git/blobs/'):
            c = self.objects[p.rsplit('/', 1)[1]][1]
            return 200, {'content': base64.b64encode(c.encode()).decode(), 'encoding': 'base64'}
        if method == 'POST' and p == '/git/trees':
            files = dict(self.objects[body['base_tree']][1])
            for e in body['tree']:
                if e.get('sha', '') is None:
                    files.pop(e['path'], None)
                else:
                    files[e['path']] = e['content']
            return 201, {'sha': self._tree(files)}
        if method == 'POST' and p == '/git/commits':
            files = self.objects[body['tree']][1]
            return 201, {'sha': self._commit(files, body['parents'], body['message'])}
        if method == 'PATCH' and p == '/git/refs/heads/main':
            new = body['sha']
            if self.objects[new][1]['parents'] != [self.head]:
                return 422, {'message': 'Update is not a fast forward'}
            self.head = new
            self.commits_log.append(self.objects[new][1]['msg'])
            return 200, {'object': {'sha': new}}
        return 404, {'message': 'Not Found ' + p}


def person(pid, first, gender='M', parents=(), spouses=(), children=(), **extra):
    data = {'first name': first, 'gender': gender, **extra}
    return json.dumps({'id': pid, 'data': data, 'rels': {
        'parents': list(parents), 'spouses': list(spouses), 'children': list(children)}}, indent=2) + '\n'


git = FakeGit({
    'README.md': 'dane',
    'people/a.json': person('a', 'Jan', **{'last name': 'Nowak', 'birthday': '1950'}, spouses=['b'], children=['c']),
    'people/b.json': person('b', 'Anna', 'F', **{'last name': 'Nowak'}, spouses=['a'], children=['c']),
    'people/c.json': person('c', 'Piotr', **{'last name': 'Nowak', 'birthday': '1980'}, parents=['a', 'b']),
})
lock = threading.Lock()


def route_github(route, request):
    path = request.url.replace('https://api.github.com', '')
    body = json.loads(request.post_data) if request.post_data else None
    with lock:
        status, data = git.handle(request.method, path, body)
    route.fulfill(status=status, content_type='application/json', body=json.dumps(data),
                  headers={'Access-Control-Allow-Origin': '*'})


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), partial(Quiet, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()

PROXY = 'https://auth.example.test'
CONFIG = ("window.FAMILY_TREE_CONFIG = {owner:'o',repo:'r',branch:'main',dir:'people',pollSeconds:10,"
          f"clientId:'test-client',authProxy:'{PROXY}'}};")
INIT = "localStorage.setItem('family-tree:auth', JSON.stringify({access_token:'test-token'}));"


def route_config(route, request):
    route.fulfill(status=200, content_type='application/javascript', body=CONFIG)


def route_authorize(route, request):
    """Atrapa github.com/login/oauth/authorize: od razu odsyła na stronę z kodem."""
    q = {k: v[0] for k, v in parse_qs(urlparse(request.url).query).items()}
    assert q['client_id'] == 'test-client' and q['code_challenge_method'] == 'S256', q
    oauth['challenge'] = q['code_challenge']
    route.fulfill(status=302, headers={'Location': q['redirect_uri'] + '?' + urlencode({'code': 'abc', 'state': q['state']})})


def route_proxy(route, request):
    if request.method == 'OPTIONS':
        return route.fulfill(status=204, headers=CORS)
    body = json.loads(request.post_data)
    verifier_hash = base64.urlsafe_b64encode(hashlib.sha256(body['code_verifier'].encode()).digest()).rstrip(b'=').decode()
    assert request.url == PROXY + '/token' and body['code'] == 'abc' and verifier_hash == oauth['challenge'], body
    route.fulfill(status=200, content_type='application/json', headers=CORS, body=json.dumps(
        {'access_token': 'test-token', 'expires_in': 28800, 'refresh_token': 'r1', 'refresh_token_expires_in': 15811200}))


CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type'}
oauth = {}

errors = []
with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # logowanie przez GitHub: przycisk -> authorize -> powrót z kodem -> wymiana na token
    ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
    ctx.route('**/config.js', route_config)
    ctx.route('https://api.github.com/**', route_github)
    ctx.route('https://github.com/login/oauth/authorize**', route_authorize)
    ctx.route(PROXY + '/**', route_proxy)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(f'login: {e}'))
    page.goto('http://127.0.0.1:8765/index.html')
    page.wait_for_selector('#login[open]')
    page.click('#login-form button')
    page.wait_for_function("document.querySelector('#status').dataset.state === 'ok'", timeout=15000)
    assert 'code=' not in page.url, page.url
    saved = json.loads(page.evaluate("localStorage.getItem('family-tree:auth')"))
    assert saved['access_token'] == 'test-token' and saved['refresh_token'] == 'r1', saved

    # wylogowanie także z GitHuba: token usunięty, przejście na github.com/logout
    ctx.route('https://github.com/logout', lambda route, req: route.fulfill(status=200, content_type='text/html', body='logout'))
    page.click('#btn-menu')
    with page.expect_navigation(url='https://github.com/logout'):
        page.click('#menu-logout-github')
    page.goto('http://127.0.0.1:8765/index.html')
    assert page.evaluate("localStorage.getItem('family-tree:auth')") is None
    page.wait_for_selector('#login[open]')
    ctx.close()
    print('logowanie i wylogowanie: OK')

    def open_user(name):
        ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
        ctx.add_init_script(INIT)
        ctx.route('**/config.js', route_config)
        ctx.route('https://api.github.com/**', route_github)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(f'{name}: {e}'))
        page.on('console', lambda m: m.type == 'error' and '422' not in m.text and errors.append(f'{name} console: {m.text}'))
        page.goto('http://127.0.0.1:8765/index.html')
        page.wait_for_function("document.querySelector('#status').dataset.state === 'ok'", timeout=15000)
        return page

    A = open_user('A')
    B = open_user('B')
    A.screenshot(path=f'{OUT}/01_loaded.png')

    # A: edytuje Piotra (klik w kartę -> formularz) i zmienia miejsce urodzenia
    def edit_person(page, card_text, field_label, value):
        page.locator('.card', has_text=card_text).first.click()
        page.wait_for_selector('.f3-form')
        page.wait_for_timeout(300)
        inp = page.locator(f'.f3-form input[placeholder="{field_label}"]')
        inp.fill(value)
        page.locator('.f3-form button[type=submit]').click()
        page.wait_for_timeout(500)

    edit_person(A, 'Piotr', 'Miejsce urodzenia', 'Kraków')
    A.screenshot(path=f'{OUT}/02_A_dirty.png')
    assert 'niezapisan' in A.inner_text('#status'), A.inner_text('#status')

    # B: równolegle zmienia nazwisko Anny (inna osoba)
    edit_person(B, 'Anna', 'Nazwisko rodowe', 'Kowalska')

    A.fill('#commit-note', 'Miejsce urodzenia Piotra')
    A.click('#btn-save')
    A.wait_for_function("document.querySelector('#status').dataset.state === 'ok'", timeout=10000)

    # B zapisuje na starej bazie -> konflikt gałęzi -> automatyczne scalenie
    B.click('#btn-save')
    B.wait_for_function("document.querySelector('#status').dataset.state === 'ok'", timeout=10000)
    B.wait_for_timeout(800)
    B.screenshot(path=f'{OUT}/03_B_merged.png')

    files = git.files_at(git.head)
    c = json.loads(files['people/c.json'])
    b = json.loads(files['people/b.json'])
    assert c['data'].get('birthplace') == 'Kraków', c
    assert b['data'].get('birth name') == 'Kowalska', b
    print('commity:', git.commits_log)

    # A: polling powinien wciągnąć zmianę B (A nie ma lokalnych zmian)
    A.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    A.wait_for_timeout(1500)
    A.locator('.card', has_text='Anna').first.click()
    A.wait_for_selector('.f3-form')
    A.wait_for_timeout(300)
    val = A.locator('.f3-form input[placeholder="Nazwisko rodowe"]').input_value()
    assert val == 'Kowalska', f'A nie zobaczył zmiany B: {val!r}'
    A.screenshot(path=f'{OUT}/04_A_form.png')

    # Konflikt tego samego pola
    A.locator('.f3-form .f3-cancel-btn').click() if A.locator('.f3-form .f3-cancel-btn').count() else None
    edit_person(A, 'Jan', 'Data urodzenia', '1951')
    edit_person(B, 'Jan', 'Data urodzenia', '1949')
    A.click('#btn-save')
    A.wait_for_function("document.querySelector('#status').dataset.state === 'ok'", timeout=10000)
    B.click('#btn-save')
    B.wait_for_function("document.querySelector('#status').dataset.state === 'ok'", timeout=10000)
    B.wait_for_timeout(500)
    banner = B.inner_text('#banner') if B.is_visible('#banner') else ''
    print('baner B:', banner)
    assert 'inna osoba' in banner
    a = json.loads(git.files_at(git.head)['people/a.json'])
    assert a['data']['birthday'] == '1949', a
    B.screenshot(path=f'{OUT}/05_B_conflict.png')
    print('commity:', git.commits_log)
    browser.close()

srv.shutdown()
if errors:
    print('BŁĘDY:', *errors, sep='\n  ')
    sys.exit(1)
print('OK')
