# API verification

## TEMPORARY CLINICAL API BLOCK

**Decision: 2026-10-22, accepted by the user.** This source revision installs a
global fail-closed access boundary: all clinical handlers return HTTP 401 before
controller/service execution. Only the existing health `GET /` handler is allowed;
automatic HEAD handling is denied. This describes repository behavior, not proof
of deployment to a running server.

The block is deliberate and **temporary**, pending verified identity and accepted
clinical resource permissions; it is not a database outage. It has no automatic
expiry or environment bypass. Evolve the narrow policy only after authentication,
resource authorization, and negative HTTP tests are proven. Do not remove the
global guard or grant every logged-in role unrestricted clinical access. No login,
refresh/logout route, JWT, cookie, or browser integration is activated here;
internal nonexpiring session foundations remain unregistered and unchanged.

`access-boundary.http.spec.ts` exercises AppModule without overriding the guard.
Appointment/odontogram controller HTTP suites and the opt-in appointment live
persistence suite explicitly override the concrete guard to test their isolated
behavior; they are **not authorization proof**. Real appointment integration still
requires separate authorization and explicit opt-in. Supply its database URL
privately through `NINA_APPOINTMENTS_TEST_DATABASE_URL`; no credential or default
database URL is embedded. Only a PostgreSQL URL targeting `127.0.0.1` is accepted,
and skipped collection creates no database/Redis client. This removes a prior
source literal, not credentials from Git history.

## Browser authentication POST admission (not registered or exposed)

`BrowserRequestPolicy` defines admission for future same-origin browser auth
POSTs, including login. It mounts no route and leaves the clinical block above
unchanged. Student LAN access must use one canonical **HTTPS** browser origin;
there is no HTTP, LAN or localhost exemption. The actual address, certificate,
TLS termination and ingress/proxy configuration remain unset activation
prerequisites, not values discovered from request headers or the environment.

The constructor requires that explicit primitive HTTPS origin with exact
`URL.origin` spelling: no paths, credentials, wildcard, whitespace or defaults.
`allowsAuthenticationPost` denies malformed inputs and requires exact `POST`
with Node's alternating string `rawHeaders`, never a normalized-header fallback:

- One `Origin` byte-matching configuration; no Host/forwarded/Referer trust.
- One `X-NINA-CSRF-Protection: 1`, a public **nonsecret marker**, not a CSRF token,
  credential or identity proof.
- One `application/json` Content-Type, optionally only `charset=utf-8`. Media type
  and charset are case-insensitive; space/tab may surround the semicolon/equals,
  but no outer whitespace, quoted charset, extra parameters or simple types.
- Optional `Sec-Fetch-Site`, if present exactly `same-origin`; it never substitutes
  for the required Origin, marker or JSON media type.

Security header names are case-insensitive and any duplicate is denied, even
identical values. No CORS allowance is introduced. Later activation must apply
this policy to every authentication POST and verify ingress: proxies can strip
or combine duplicates before Node. Tests prove only the delivered Node header
representation, not unchanged wire bytes or browser/TLS operation.

Nonbrowser clients can forge these headers; admission proves neither identity
nor TLS and does not cover same-origin XSS or client-side CSRF. The policy does
not parse or validate a JSON body. Cookie retention/deletion, no-store registration,
login attempt limits, route/frontend activation and clinical authorization are
separate pending behaviors. No browser session flow or deployment is activated.

## Browser session cookie fields (not registered or exposed)

`BrowserSessionCookies` serializes two separate Set-Cookie field values, access
first, or returns `null` if either credential is invalid. It never emits an HTTP
response or sets browser cookies. Trusted internal callers must supply freshly
issued credentials: syntax checking proves no signature, identity, freshness,
session ownership or permission. Do not accept request values as issued tokens.

The required constructor configuration copies integer `accessMaxAgeSeconds`
(1–900) and `refreshMaxAgeSeconds` (1–34,560,000). There are no default activation
values, environment/clock reads, or dependencies on keys, hosts or services.
The 400-day application ceiling follows [Chrome's documented lifetime cap](https://developer.chrome.com/blog/cookie-max-age-expires?hl=en),
not a universal browser guarantee or backend session duration.

Fixed names are `__Host-nina-access` and `__Host-nina-refresh`, each with
`Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=<configured seconds>` and no
Domain. There is no insecure/LAN/localhost toggle or caller-selected attribute.
Access values require three nonempty base64url-alphabet segments; no JWT decode
or verification occurs. Refresh values require the existing canonical 32-byte,
43-character base64url format. Injection characters and oversized values deny;
each complete ASCII field is at most 4096 bytes, not the JWT verifier's 8192
input limit. Never truncate tokens or comma-join the two fields. Returning a pair
is not atomic browser storage or a guarantee of browser acceptance/retention.

`clear()` returns matching names, host-only scope, Path and security attributes,
empty values, `Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`. Future emission
must use the same HTTPS host. This is deletion serialization, **not backend
revocation or working logout**; a future logout route must perform the accepted
server-side revocation independently. No raw refresh JSON/localStorage is added.

Explicit null backend expiry and no time/idle forced-login policy are unchanged.
Browser expiry, clearing, eviction or another browser can still require login;
future successful issuance/rotation may renew finite retention, never guarantee
permanent storage or retry consumed credentials. Response delay can leave an
access cookie after JWT expiry: JWT `exp` and current online session/account
checks remain authoritative. HttpOnly does not stop XSS-triggered requests;
SameSite does not replace Origin/CSRF admission. LAN requires the same-origin
HTTPS contract; actual address, certificate and ingress remain unset until
activation. Clinical blocking, request parsing, no-store registration, login limits and route
activation remain unchanged/deferred. No browser/TLS/deployment proof is claimed.

Protocol references: [MDN cookie attributes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie),
[matching deletion](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies),
[RFC6265 limits/eviction](https://httpwg.org/specs/rfc6265.html#section-6.1),
and [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Browser request session-cookie extraction (not registered or exposed)

`BrowserSessionCookieReader.read(request)` returns a fresh readonly snapshot with
nullable `accessToken` and `refreshToken`, or `null` for malformed or ambiguous
input. Missing Cookie fields and unrelated well-formed cookies yield both values
null. Either credential can appear independently: refresh extraction must remain
possible after the access cookie expires. Callers decide later which credential
their route requires; this reader performs no renewal or authentication.

The input must provide Node's alternating string `rawHeaders` array with valid
header names. Zero or one case-insensitive Cookie field is accepted; duplicate
fields deny even with identical values. There is no normalized-header,
Authorization, body, query, decoding or alternate-name fallback. Proxies can
alter duplicates before Node; later ingress verification remains necessary.

The deliberately narrow application grammar accepts a nonempty ASCII Cookie
value of at most8192 bytes: HTTP-token names, first `=` separating each name and
value, and unquoted RFC6265 cookie-octet values. Pairs are separated by semicolons
with zero or more following ASCII spaces. Leading/trailing whitespace, spaces
around `=`, tabs, quotes, backslashes, commas, controls, Unicode and empty or
malformed pairs deny the whole result. Unrelated empty values, literal `=` and
`%` remain allowed; this is not a generic/full RFC cookie parser.

Only exact case-sensitive `__Host-nina-access` and `__Host-nina-refresh` names
are extracted. Duplicate NINA names or an invalid present credential deny the
entire result, never first/last selection or partial success. Access input is
at most4096 characters with three nonempty base64url-alphabet segments; refresh
input is canonical32-byte/43-character base64url. Values are never trimmed,
decoded, concatenated or truncated. These are input bounds, not browser limits.

Parsing proves neither signature nor current account/session validity, CSRF
admission, identity, TLS or clinical permission. Request cookies do not reveal
their original Secure/HttpOnly/SameSite attributes. The existing access verifier,
online session checks and POST admission remain separate requirements. Null
backend expiry, no time/idle forced-login policy, consumed-refresh denial and the
temporary clinical block remain unchanged. No route, browser login/logout,
cookie emission, LAN/TLS configuration or deployment is activated.

References: [RFC6265 request-cookie syntax and semantics](https://httpwg.org/specs/rfc6265.html#section-4.2),
[Node rawHeaders](https://nodejs.org/api/http.html#messagerawheaders).

## Browser authentication no-store boundary (not registered or exposed)

`browserAuthNoStore` is a dependency-free functional Express middleware. It
replaces `Cache-Control` with exactly `no-store` before continuing once. It reads
no request properties or credentials and changes no status, body, unrelated
headers, cookies or session state. Header-write failures propagate rather than
continuing with an apparently protected response.

Future activation must register this middleware with `app.use(...)` on the
complete authentication boundary **before** `init()`/`listen()` and any body
parser. This must cover successful responses and all relevant failure paths,
including login rejection and malformed or oversized bodies. Nest module-only
middleware or an interceptor would run too late for earlier parser errors.
Later handlers, filters and ingress must not override this policy; the middleware
does not wrap response methods or prevent deliberate later header replacement.

`Cache-Control: no-store` instructs cooperative private and shared HTTP caches
not to store the request or response. `no-cache` or `private` alone are not
equivalent. This is not encryption, session revocation, a privacy guarantee, or
retroactive cache/history erasure. No additional cache headers or client-storage
clearing directives are emitted.

HTTP tests use only a tiny isolated test application, synthetic handlers and an
explicit test-only parser limit. They prove header behavior through success,
guard/handler errors and parser rejection; they do not activate authentication
routes or protect a running NINA deployment. Main bootstrap, the temporary
clinical block, null backend expiry, refresh policy and all remaining body,
attempt-limit, origin/TLS/ingress and authorization prerequisites stay unchanged.

References: [RFC9111 no-store](https://httpwg.org/specs/rfc9111.html#section-5.2.2.5),
[Nest functional/global middleware](https://docs.nestjs.com/middleware).

## Browser login-input extraction (not registered or exposed)

`BrowserLoginInputReader.read(body)` accepts an already-parsed plain record with
exactly two own enumerable data fields, `username` and `password`, both strings.
It returns a fresh frozen readonly snapshot or `null`, never partial extraction.
Null-prototype records are allowed; arrays, class/custom-prototype instances,
inherited, extra or symbol fields, accessors and malformed shapes are denied.
Credential getters are never invoked; throwing reflective operations fail closed.
Inputs are not mutated, coerced, trimmed, canonicalized or Unicode-normalized.

Username input is at most 128 UTF-16 code units. Password input is at most 1024
UTF-8 bytes, with a cheap 1024-code-unit bound before byte counting. These are
transport ceilings, **not authentication eligibility**: empty, short or otherwise
ineligible strings may pass extraction. Existing username canonicalization and
password verification remain authoritative, including Unicode validity checks.
No identity, password hashing, cookie fallback, session operation or logging is
performed. The snapshot still contains sensitive input; callers must not log it.

This reader cannot detect duplicate raw JSON keys already collapsed by parsing
or enforce pre-parser request-byte limits. Those parser protections and login
attempt controls remain activation prerequisites; this is not complete request
resource protection. No route, middleware, module or frontend is registered.
The temporary clinical block, null backend expiry, strict consumed-refresh denial,
and pending origin/TLS/ingress requirements remain unchanged. No browser login,
HTTP runtime, database or deployment proof is claimed by these pure reader tests.

## Bounded browser HTTP JSON input (not registered or exposed)

`createBrowserAuthJson({ maxBytes, readTimeoutMs })` creates an unregistered
dependency-free Express middleware. Both limits are mandatory copied positive
safe integers: bytes cannot exceed Node's Buffer maximum and the read deadline
cannot exceed 2,147,483,647 milliseconds. There are no production values/defaults
or environment reads. A body-read deadline is **not session expiry**.

The reader requires untouched binary IncomingMessage input: no body marker,
earlier consumption/reader, ended/destroyed stream or text encoding. It accepts
absent Content-Encoding or exactly one case-insensitive identity value only;
compressed, unknown, combined and duplicate encodings are denied, not inflated.
Actual entity bytes are counted before retaining chunks; HTTP transfer/chunk
framing is excluded. Content-Length is only an early rejection hint. The crossing
chunk is not retained and input is never truncated or partially parsed.

Oversize input receives generic 413, unsupported encoding 415, invalid input 400
and an unfinished read 408 where writable. Rejected connections close without
waiting for an attacker-controlled tail. Abort/error/response completion clears
the reader's own buffers/listeners/timer; only successful complete reads continue
once. Disconnected clients may receive no response. No shared server/socket
timeout policy is changed. The accumulator bound excludes socket/runtime buffers,
a delivered chunk, bounded copying/decoding and concurrency; this is not complete
DoS protection or an ingress/header-timeout policy.

Complete bounded bytes must pass `isUtf8` before UTF-8 decoding and JSON.parse.
Empty, BOM-prefixed, malformed and trailing-junk JSON is rejected without repair.
Before publishing the parsed body or continuing, an iterative lexical scan of the
original text rejects repeated decoded keys within each object with generic 400.
Native JSON.parse remains the syntax authority and decodes each complete key
token; escaped equivalents collide, including nested objects inside arrays.
Object-local sets avoid prototype-name hazards and allow keys repeated across
different objects. String escapes and punctuation inside values do not create
keys. Comparison does not normalize Unicode, case or surrogate code units.

The scanner does not recursively parse a JSON grammar or reparse subtrees. Its
traversal and auxiliary storage are bounded by source size; parsing, decoded
strings, sets and concurrency still consume resources. The read deadline bounds
asynchronous body reading, not synchronous parsing/scanning or total CPU time.
All other valid JSON values are preserved: parsing is not authentication or the
login reader's exact-field/string validation. Attempt controls and the other
activation requirements below remain pending.

Future activation requires early no-store → request admission → this reader →
handler, before/bypassing default parsers. Module-only placement after a global
parser is insufficient. No main/AppModule, route or frontend registration occurs.
Isolated HTTP tests prove owned synthetic loopback behavior, including rejection
before client end; not real NINA/browser/TLS/proxy/deployment protection. Node or
proxy framing errors before middleware cannot promise its no-store header. The
clinical block, null backend expiry, strict consumed-refresh denial and pending
canonical origin/TLS/LAN ingress/authorization requirements remain unchanged.

## Isolated browser login composition (not registered or exposed)

`createBrowserLoginHandler(services, config)` composes the existing protections;
it registers no route and leaves the clinical block unchanged. Supply typed
creation/access/revocation ports and explicit canonical HTTPS origin, JSON byte
and read-deadline limits, and access/refresh cookie ages. Existing constructors
validate and copy configuration; there are no environment reads or defaults.

The boundary runs no-store → exact POST/Origin/public-CSRF-marker admission →
bounded duplicate-safe JSON → exact login-input extraction →
`create(username, password, null)` → session-bound access issuance → complete
cookie-pair serialization. Success is empty HTTP 204 with two separate Secure,
HttpOnly, SameSite=Strict, host-only cookie fields. No credentials, session IDs
or identity are returned in JSON or logged. Backend expiry remains explicit null;
finite access-token/cookie retention is not a time/idle forced-login policy.

Admission returns generic 403 before reading the body or calling services;
invalid login shape returns 400, creation denial 401, and internal failure 500.
The body reader retains its generic 400/408/413/415 responses. Application-handled
responses are no-store; rejected connections close without unbounded draining.
Disconnected clients and pre-application Node/proxy failures may receive nothing.

Only a known-created, not-yet-dispatched session gets one best-effort owner-scoped
revocation attempt after issuance/serialization failure or lost response. Buffered
cookies are removed before cleanup, or the response is destroyed if removal fails.
Creation null/throw can hide an ambiguous commit: never invent an ID or retry.
Cleanup false/throw proves no rollback. Once dispatch is attempted, delivery is
ambiguous, even if the write throws: no automatic revocation on later socket close,
retry, refresh grace, family/account revocation or uninterrupted-access promise.

`browser-login.http.spec.ts` uses only a tiny parser-disabled Nest application,
owned loopback clients, ephemeral RSA keys and typed service doubles. It checks
successful online validation, admission/body rejection, failure cleanup,
disconnects and concurrent isolation; it is not actual NINA/browser/TLS/database
or deployment proof. Activation still needs canonical HTTPS/trusted ingress,
pre-parser production wiring, server/proxy limits, login-attempt controls and
whole-application negative proof. Scrypt queue bounds are not throttling. Resume,
voluntary logout, frontend and accepted clinical permissions remain separate.

## Isolated browser refresh composition (not registered or exposed)

`createBrowserRefreshHandler(services, config)` composes typed rotation/access
ports with explicit canonical HTTPS origin, JSON byte/read-deadline limits and
cookie ages. It registers no route, changes no existing service or clinical
guard, and reads no environment/default credentials. Mount it before other body
readers only when production activation is separately authorized.

The order is no-store → exact POST/Origin/public-CSRF-marker admission → bounded
duplicate-safe JSON → empty object `{}` → strict cookie extraction → one rotation
→ online session-bound access issuance → complete cookie-pair serialization.
Refresh-only requests work without a current access credential; a malformed
companion access cookie still rejects the entire envelope. There is no credential
or identity fallback from the body, query, Authorization header or access token.
Success is empty HTTP 204 with two separate Secure/HttpOnly/SameSite=Strict,
host-only cookie fields, never credentials, session IDs or identity in JSON/logs.

Admission returns generic 403; nonempty/nonobject JSON returns 400; missing or
malformed refresh cookies and rotation denial return 401. The existing body
reader retains 400/408/413/415. Dependency throws, issuance failure and cookie
serialization/header failures return generic 500 where writable. Application
responses are no-store; rejection closes without unbounded draining. Disconnected
clients and pre-application Node/proxy failures may receive nothing.

Serialize both cookie fields before setting either. Before dispatch failure,
remove any buffered credential fields or destroy the response if removal fails.
After dispatch is attempted, even a thrown write has an ambiguous outcome.
Unlike new-session login cleanup, refresh never compensates an existing session:
no automatic session/family/account revocation, retry, stale acceptance, grace or
successor recovery. A rotation commit followed by issuance failure or a lost
response can strand the browser; neither null nor failure proves rollback.
Explicit null backend expiry and voluntary logout remain unchanged; finite access
and cookie ages do not impose time/idle forced login or permanent browser storage.

`browser-refresh.http.spec.ts` uses parser-disabled tiny Nest, owned loopback,
ephemeral RSA keys and typed doubles, including stateful rotation doubles. These
prove HTTP ordering/denial/failure isolation, not live PostgreSQL races, rollback,
TLS or actual browser storage. Production HTTPS/trusted ingress, pre-parser
wiring/limits/attempt controls, frontend single-flight refresh, verified-session
logout and accepted clinical resource permissions remain separate requirements.

## Internal access credentials (not registered or exposed)

`AccessCredentialService` is constructor-configured and unregistered. Its
`issue(sessionId, ownerId, authVersion)` first requires successful online
`SessionService.validate`. `verifySession(token)` is the single verification
pipeline: it verifies the signature and strict header/claims before a fresh online
check, then returns `{ sessionId, account }`. The session ID comes from the
verified signed `sid`; the account is the **current** online identity, not token
roles or client-supplied identity. `verify(token)` calls this same pipeline and
projects only the account, preserving its account-only API and `null` failures.
Each invocation performs its own online validation without cached authorization.
Errors or online denial return `null`, with no supplied values logged. Invalid
configuration throws only a generic configuration error.

The exported `VerifiedAccessSession` interface has readonly `sessionId` and
`account` fields. This is a TypeScript contract, not runtime freezing, a guarantee
against concurrent revocation, or permission to revoke a session. No unverified
JWT decoding, second verifier or authentication bypass is introduced. The result
supports later owner-bound operations; it does not implement logout, select an
expired-access logout policy, register a route/provider, or grant clinical access.

Callers must explicitly supply matching local RSA private/public `KeyObject`s
with at least 2048-bit moduli, exact issuer/audience strings, and an integer
`lifetimeSeconds` of 1–900. Configuration and keys are copied at construction.
There are no defaults, environment reads, remote key lookups, or provisioning
mechanisms. Direct `jsonwebtoken` 9.0.3 fixes RS256; the protected type is
`nina-access+jwt`. No token-selected key, algorithm negotiation, or insecure
compatibility option is enabled.

Tokens contain only `sub`, `sid`, `authVersion`, `iat`, `exp`, `iss`, and `aud`.
Verification bounds input to 8192 characters, requires exact header/claim shape,
UUID identities, a bounded integer authentication version and nonnegative safe
integer dates, rejects future issuance and excess lifetime, and denies at the
exact expiry boundary, including after awaited online validation. Tokens carry
no username, role, refresh credential, or clinical permission.

This short credential lifetime is **not a backend session duration or forced-login
policy**. Explicit null backend expiry remains unchanged; finite or revoked
sessions still fail online validation even with a cryptographically valid token.
Issuance/verification adds no renewal, recovery, or uninterrupted-access promise.
The temporary clinical block above remains intact: no browser login, HTTP
transport, cookie policy, module registration, or clinical access is activated.
Deterministic tests use ephemeral keys, fake time and session doubles. Both
verification APIs share the malformed-input, signature, header and claim denial
matrices. Tests also cover account-only compatibility, current identity/version
and revocation denials, post-await token expiry/clock rollback, and independent
concurrent session/owner results. Existing session tests independently cover
nullable expiry. No live database, HTTP, browser or logout proof is claimed by
these credential tests.

## Local account password hashing foundation (not exposed)

The auth module provides a reusable password hash/verify foundation and an
unexposed account-schema foundation; it does not create account-management or
authentication routes. Accounts are NINA-managed with administrator-only
creation. The initial release is limited to fictitious patients. Roles are
explicitly assigned as `ADMIN`, `INSTRUCTOR`, or `STUDENT`; no administrator
clinical access, instructor-wide case access, or clinical identity linkage is
implied. Password inputs must contain 15–128 Unicode code points and no more
than 1,024 UTF-8 bytes. Inputs are used exactly as supplied: whitespace is not
trimmed and Unicode is not normalized.
Ill-formed UTF-16 surrogate sequences are rejected; valid paired Unicode is
preserved as supplied.

Hashes use a versioned canonical format with a random 16-byte salt and Node's
asynchronous scrypt implementation fixed at N=131,072, r=8, p=1, a 64-byte key,
and an explicit 192 MiB memory limit. The parser rejects unknown versions,
parameters, noncanonical base64url, oversized values, and malformed fields
before running scrypt. At most two derivations run concurrently, with up to 16
queued; additional work is rejected with a generic capacity error. Plaintext
passwords and stored hashes must not be logged.

This uses OWASP's documented scrypt alternative; OWASP prefers Argon2id for new
systems. See the [Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
and [Node.js `crypto.scrypt`](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).

Usernames are trimmed only at their outer whitespace and canonicalized to
lowercase ASCII; accepted names are 3–32 characters using letters, digits,
periods, underscores, or hyphens, and must start with a letter or digit. The
additive migration enforces the canonical form and nonnegative `authVersion`
with SQL checks that Prisma's schema DSL cannot represent. It has not been
deployed to an existing application database; isolated PostgreSQL15 proof is
separate from deployment. No account rows, default credentials, or administrator
are seeded. `authVersion` does not activate authentication by itself; the
unregistered creation service below rechecks the credential snapshot only.

## Internal credential authentication (not registered or exposed)

`CredentialAuthenticationService.authenticate(username, password)` composes the
existing canonical username and bounded scrypt helpers with a narrowly selected
Prisma account lookup. Only an active account with matching credentials returns
a fresh `{ id, username, role, authVersion }` snapshot. Password/hash material,
clinical identity, and resource permissions are never returned or inferred.

All rejected credentials, missing/inactive accounts, and caught database or
verifier errors return `null`; supplied material and underlying errors are not
logged or propagated. Inactive accounts still use their stored password hash.
Missing accounts use a lazy per-service random nonaccount hash through the same
bounded helpers, shared across concurrent preparations and retried on a later
call if preparation fails. Even a dummy match cannot authenticate a missing
account. The first missing-account request includes hash preparation; malformed
inputs/hashes and infrastructure failures may take different paths. This does
not promise equal response timing, request throttling, or an HTTP error policy.

This service is deliberately unregistered: no route, global guard, token,
account, secret configuration, or session policy is added. The identity snapshot
is not a session and does not establish ongoing account activity or revocation
checks. It does not activate authentication or grant clinical access; global
fail-closed authentication and resource authorization remain future work. Tests
use mocked Prisma, synthetic inputs, and actual password-helper composition
without starting the application or connecting to a database.

## Session persistence foundation (not registered or exposed)

The additive `AuthSession` and `RefreshToken` schema records account-bound
sessions, issued `authVersion`, nullable expiration, session revocation and
refresh-token consumption. Each token row stores only a unique canonical
64-character lowercase SHA-256 digest, with SQL C-collation and format checks;
no raw token or password is copied. Separate retained token rows support future
replay analysis; the internal rotation contract is described below.
Restrictive foreign keys prevent deleting or reassigning referenced accounts
and sessions while dependent rows remain. No clinical identity is linked.

New session/token timestamps use `TIMESTAMPTZ(3)` (Prisma `Timestamptz(3)`),
representing instants independently of the database session's display time zone.
The original migration requires finite creation/expiration times and expiration
after creation. The follow-up
`20261021200000_allow_nonexpiring_auth_sessions` migration permits explicit null
expiry in both tables while retaining finite creation and ordered finite expiry
for existing rows. Revocation/consumption remain nullable, finite when present,
and not before creation. Only the expiry nullability and named lifetime checks
change: no data backfill, defaults, foreign-key/index changes or infinity
sentinels are introduced. Existing finite values are not rewritten.

For controlled nonpublic student practice, the selected backend outcome is no
time/inactivity-based forced login, with voluntary logout and security/account
revocation retained. Persistence and internal creation, validation and rotation support explicit null
expiry as described below. Undefined or malformed expiry
is not an implicit nonexpiring credential. Row checks do not establish cross-row
null/finite expiry matching; service changes must preserve that binding and all
account checks. Repository `strictNullChecks: false` means a passing API build
does not prove runtime null support.

These migrations have not been applied to an existing application database. Offline
schema/SQL assertions and Prisma validation/generation are not PostgreSQL runtime
or concurrency proof. No route, guard, module registration, account or browser
persistence is added. Remembered login across browser closure remains future
integration, not a promise of perpetual access.
Global fail-closed authentication and resource authorization remain required
before protected API or dispensing exposure.

Rollback before deployment is limited to this persistence unit. After null rows
exist, restoring NOT NULL requires a separate migration/data decision; no row
rewriting, deletion, or automatic database downgrade is authorized here.

## Internal session creation (not registered or exposed)

`SessionCreationService.create(username, password, expiresAt)` composes credential
verification with a bounded serializable transaction. The third argument is
required: exact `null` explicitly requests no time-based expiry; an actual valid
finite future `Date` retains legacy finite expiry. Omitted, undefined, malformed,
invalid or Date-like values deny before credential/database work. Finite expiry
is captured numerically before awaiting credentials and rechecked after account
lookup and transaction settlement, independently of mutable Date objects. Null
survives clock advancement without skipping current account identity, activity
or `authVersion` checks. The session and initial refresh row are created atomically
with shared creation timestamps and identical null or cloned finite expiry.
`CreatedSession.expiresAt` returns `Date | null`. A fresh 32-byte CSPRNG credential is persisted only
as its lowercase SHA-256 digest; raw refresh material and a minimal current
account identity are returned only after successful commit and a final expiry
check. Rejection or caught dependency/transaction/commit failure returns `null`
without retry or exposing details. A failure response does not prove no row was
committed, including when expiration passes during commit.

Transaction wait/execution bounds are infrastructure limits, not session lifetime
policy. Explicit-null issuance implements the selected no-time-expiry practice
policy internally; it does not activate public login or browser persistence.
Tests use typed dependency doubles and a controlled clock; they do not prove live
PostgreSQL rollback, races or isolation. Creation alone does not establish an
ongoing check or logout integration; the internal collaborator below provides
validation without exposing it through the application.
Refresh rotation is internal-only as described below; JWT verification,
HTTP/cookie transport, global guards and account-security operations that advance
`authVersion` remain future work.

## Internal session validation (not registered or exposed)

`SessionService.validate(sessionId, ownerId, authVersion)` expects access claims
already verified by a future authenticating caller; these identifiers are not
bearer credentials. Canonical lowercase UUIDs and an integer version in
`0..2147483647` are required before database access. A bounded repeatable-read
snapshot checks owner/account binding, both stored versions, current activity,
revocation and finite creation no later than the current time. Expiry must be
exactly `null` (no time-based expiration) or an actual valid, finite, unexpired
`Date`; undefined, wrong types, invalid dates and Date-like objects are rejected.
Null expiry does not bypass any account, ownership or security check.

Finite expiry is captured numerically inside the transaction and rechecked after
awaited settlement; null remains nonexpiring across clock advancement. The
returned identity contains only minimal current database fields, not claimed
roles or clinical permissions. Denials and caught lookup/transaction/commit
errors return `null` without retry or diagnostics. The snapshot does not guarantee
latest-at-return revocation visibility or retroactively cancel in-flight work.

Validation performs no writes. Owner-scoped revocation remains unchanged and
works independently of expiry, including owned null-expiry sessions. Initial
nonexpiring issuance belongs to the credential-backed creation service;
validation and rotation do not create initial sessions. Typed dependency doubles and a controlled
clock cover internal boundaries, not live PostgreSQL rollback, races or isolation.
No routes, module registration, JWT verification, cookies, frontend persistence,
or public logout button are added.

## Internal owner-scoped session revocation (not registered or exposed)

`SessionService.revoke(sessionId, ownerId)` also requires a future caller that
already verified its access credential; identifiers alone are not bearer
credentials. Malformed IDs are rejected before database work. A bounded
repeatable-read transaction reads only owner, creation and revocation fields;
missing or foreign sessions return `false`, even if already revoked. Owned
already-revoked sessions return `true` without timestamp rewriting. Otherwise a
conditional owner/session/unrevoked update records a timestamp no earlier than
finite creation, including when the wall clock moves backward. Refresh rows and
clinical permissions are untouched.

Success requires an already-revoked owned session or exactly one conditional
update, and is returned only after transaction settlement. Zero writes and
caught lookup/write/transaction/commit failures return `false` without diagnostics
or retry; false does not establish whether a commit occurred. No public logout,
in-flight cancellation guarantee, session lifetime policy or transport is added.
Isolated typed revocation doubles preserve validation's no-write tests; these
checks do not prove live PostgreSQL rollback, concurrency or isolation.

## Internal refresh-authenticated session revocation (not registered or exposed)

`RefreshSessionRevocationService.revoke(refreshToken, expectedBinding?)` authenticates
the current refresh credential and revokes only its linked owner-bound session in
one bounded Serializable transaction (`maxWait=2000`, `timeout=5000`). It accepts
only canonical 43-character/32-byte base64url input and looks up its SHA-256 digest.
The minimal selection reads token/session IDs, lifecycle timestamps, account ID,
activity and authentication versions; it does not select usernames, roles or
password hashes. Unconsumed/unrevoked state, exact linkage, current activity/version,
creation ordering and matching null-or-finite future expiry are required.

An omitted second argument permits refresh-only authentication. A supplied
`VerifiedAccessSession` constrains session ID, account ID and version only; those
values are snapshotted before awaits, never select the lookup or replace refresh
authentication. A supplied malformed constraint, including explicit `undefined`,
denies rather than being ignored. No JWT decoding or access verification occurs
here; the caller must already have verified any supplied access binding.

The operation conditionally consumes only the presented token, then conditionally
revokes only the matched session; each update must affect exactly one row. Count
failure or invalid time after an await throws inside the transaction callback to
request abort rather than commit partial consumption. Captured numeric expiry and
owner/version state resist caller/double mutation across awaits. The clock must
remain finite, Date-representable and nondecreasing during the operation. True is
returned only after transaction settlement and a final time/expiry check. False
or a caught dependency/serialization/commit failure does not establish rollback
or whether revocation took effect; no retry is attempted. A failed post-settlement
time check cannot undo an already committed operation.

No successor, random credential, rotation, issuance, account-version write,
family/all-session or other-token mutation occurs. Explicit null backend expiry,
consumed-token denial and the clinical block stay unchanged. This internal class
activates no provider, HTTP/logout route, cookie deletion, frontend or deployment.
Typed Prisma doubles prove checks, scoped calls, callback-abort intent and awaited
settlement, not actual PostgreSQL rollback, contention, latest-at-return account
state or in-flight cancellation. Real owned-database service proof remains separate.

## Internal refresh rotation (not registered or exposed)

`RefreshRotationService.rotate(refreshToken)` accepts only canonical 32-byte
base64url material compatible with initial issuance. Its SHA-256 digest locates
the persisted credential. A bounded serializable transaction verifies token,
session/owner/account linkage, current activity/version, revocation, finite
creation ordering and exact token/session expiry binding. Expiry must be paired
explicit `null` values (no time-based expiration), or actual valid finite future
`Date` values representing the same instant. Mixed null/finite, missing,
undefined, malformed, invalid or unequal expiries deny before writes; Date-like
objects are not accepted. It conditionally consumes one unconsumed row and creates one fresh digest-only
successor in the same session, retaining the existing expiration without a new
duration or extension. Old rows remain. Raw successor material and minimal current
identity are returned only after transaction settlement. Successor persistence
and the result retain exact null, or independent Dates cloned from the captured
finite instant. After settlement, the captured finite expiry is rechecked even
if Date objects have mutated; null survives clock advancement. Initial issuance
is handled separately by the credential-backed creation service, not rotation.

For controlled nonpublic testers, consumed-token reuse **denies without automatic
session, family or account revocation**. Missing/invalid credentials, conditional
losers, serialization conflicts and caught dependency/commit failures return
`null`, without diagnostics, grace, stale acceptance or automatic retry. Raw input
and successor material are never persisted or logged. An ambiguous commit or lost
response may leave the client without its successor even while its session stays
valid: null does not prove no commit, and lost-response recovery or uninterrupted
access is not promised. No account/session revocation or version write occurs.

The service remains unregistered: no HTTP/JWT/cookie transport, browser storage,
public login, lifetime policy or production rollout is activated. Controlled clock,
randomness and typed transaction doubles test these boundaries; they do not prove
live PostgreSQL rollback, races or serializable isolation.

## Training-account PostgreSQL assertion SQL (import-only)

`scripts/training-accounts-postgres-sql.cjs` builds a bounded transaction that
asserts the training-account migration's constraints using a caller-provided
format-validated scrypt hash and UUID. It performs no database, filesystem, process,
or environment access. The generated SQL contains the hash for fixture inserts:
callers must not log the SQL or any input values. Its fixed checkpoint metadata
contains only stage names and expected SQLSTATEs. The synthetic tests inspect
the builder and existing migration text; they do not prove PostgreSQL runtime
behavior or connect to a database.

## Training-account PostgreSQL recovery foundation (import-only)

`scripts/verify-training-accounts-postgres.cjs` contains import-only recovery
helpers, not a command or database runner. It records only fixed stage/reason
codes, bounded process status, and allowlisted SQLSTATE/Node codes in a private
recovery manifest. Resource removal requires independent inspection of the
factory-created run identity, exact image ID, labels, and name; uncertain or
foreign resources retain the private evidence. Creation calls are tracked until
settled; cleanup waits for them before inspecting or removing resources. A pass
requires successful proof and confirmed cleanup. Cleanup executor calls receive
a fixed five-second bound and no proof-abort signal. Its tests use synthetic
executors only; they do not connect to PostgreSQL or invoke Docker.

The helper also accepts only the fixed `proof_sql` and `postgres_env` artifact
kinds, stored as `proof.sql` and `postgres.env` inside its factory-owned private
root. Content is bounded, written once to exclusive mode-0600 files, and never
copied into the metadata-only recovery manifest. The manifest records intent
before file creation and the created file's device/inode before content is
written; ambiguous writes, legacy unregistered files, replacements, links, or
foreign inventory retain recovery evidence. Version-one manifests reopen with
an empty artifact inventory and never adopt files by name. No cross-process
concurrency guarantee is made; this lifecycle does not read environment values
or create credentials, and its tests use synthetic content only.

`validatePreparedArtifacts(context)` is a read-only check for active prepared
fixtures. It revalidates the canonical private root and both complete registered
files, including mode, owner, link count, device, inode, and size, then returns
only the two fixed artifact paths. It refuses pending, finalizing, or already
completed recovery contexts and does not provide deletion authority.

## Training-account PostgreSQL fixture preparation (import-only)

Run `npm run build --workspace=@nina/api` before importing
`scripts/training-accounts-postgres-fixture.cjs`; it loads the compiled password
hasher, not TypeScript source. Preparation reads only the fixed account migration
and compiled helper. `readTrainingAccountMigration()` exposes the same bounded,
canonical-file-validated migration read without accepting a caller-supplied path.
The compiled helper executes from its validated source bytes with only its
`node:buffer` and `node:crypto` dependencies, rather than resolving through the
module cache. Preparation generates separate random synthetic account and database
credentials, and writes bounded SQL and PostgreSQL environment content through
the private recovery API. Its frozen result contains only generated names,
private artifact paths, and fixed assertion metadata. It does not start
PostgreSQL or Docker and never reads ambient environment configuration.

Scrypt work cannot be cancelled once started. Callers must await fixture
preparation to settle before beginning resource reconciliation or finalization;
this import-only helper does not establish cross-process concurrency safety.

## Training-account PostgreSQL command planning (import-only)

`scripts/training-accounts-postgres-plan.cjs` produces frozen argument arrays
for a fixed cached-image inspection, isolated network/container creation,
readiness check, and SQL assertion command. It accepts only a factory-owned
recovery context and the matching prepared fixture; it does not execute
commands or read environment variables. Before planning the bind mount, it
revalidates both complete private artifacts and their recorded file identities.
The container plan uses the fixed `postgres:15-alpine` reference only for image
inspection, then requires the recovery context's bound immutable image ID.
It requests an internal bridge, no host ports or persistent volumes, a
read-only root filesystem with bounded temporary filesystems, and a read-only
SQL bind mount. The entrypoint runs as root so it can initialize PostgreSQL's
temporary data directory; the assertion command also runs as root to read the
mode-0600 SQL mount and sets `PGPASSWORD` only inside the container process
environment. PostgreSQL host authentication is configured by the generated
fixture for SCRAM. These are planned arguments, not evidence that Docker,
image availability, mount permissions, initialization, or database assertions
have succeeded. The container flags follow the [Docker create CLI contract](https://docs.docker.com/reference/cli/docker/container/create/),
and the root-to-`postgres` initialization behavior comes from the
[official PostgreSQL image entrypoint](https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh).
Synthetic tests inspect the plan without invoking Docker.

`scripts/training-accounts-postgres-runtime.cjs` exports an import-only
`runTrainingAccountPostgresProof({ signal } = {})` entry point. It owns fixture
preparation, fixed `/usr/bin/docker` execution through the local daemon socket,
image and owned-resource observations, bounded readiness, authenticated TCP
server-version validation, exact SQL receipt parsing, and independent owned
resource cleanup. Child processes receive a small fixed environment; failed
stdout is never treated as proof, and recovery evidence is retained whenever
proof or cleanup is incomplete. Its VM tests use synthetic dependencies only:
they do not demonstrate Docker availability, a running PostgreSQL server, or
live database proof.

## Training-account PostgreSQL image observations (import-only)

`training-accounts-postgres-observations.cjs` validates bounded JSON returned
by the fixed `postgres:15-alpine` image inspection plan. It accepts only Linux
images for explicitly supported `amd64` and `arm64` architectures, a canonical
immutable image ID, the expected tag association, and PostgreSQL 15 startup
metadata (`PG_MAJOR`, `PG_VERSION`, `PGDATA`, entrypoint, command, and user).
The result contains only the immutable ID and safe version/architecture fields;
rejected observations use a fixed generic error. This confirms inspected tag
metadata association only. It does not establish publisher provenance or the
version of a running database server, and does not execute Docker.

Image `Config.User` may be omitted or explicitly empty; any other explicit value
is rejected. This image-metadata rule does not relax the separate container
isolation requirement that the actual container `Config.User` is exactly `0`.

Resource-inspection recovery diagnostics may include one closed inspection phase
(`network_created`, `container_created`, or `container_running`) and a fixed
predicate such as `network_id`, `ports_shape`, `planned_bind_options`, or
`actual_bind_mode`. Other predicate values identify only a broad validator
group. Command failures record the phase without claiming a validator
predicate. Raw inspection values, error text, paths, environment data, and
credentials are never persisted; older version-one and version-two recovery
manifests remain readable without these optional fields.

The same module's `validateTrainingPostgresNetwork()` checks one bounded
network-inspection object against a factory-owned recovery context. It requires
the registered network ID/name, exact owner/run labels, an internal bridge,
and only the expected registered container membership for the requested
phase. The frozen result contains confirmation metadata, not resource-removal
authority. The recovery-state read API exposes persisted proof and cleanup
flags but not its transient finalizing flag; callers must serialize validation
against finalization rather than treating this validator as a finalization
lock. Synthetic tests do not prove a live daemon's inspection behavior.

`validateTrainingPostgresMounts(context, containerJson)` is the import-only
mount-specific check. It obtains the SQL source path from the private artifact
identity validator rather than accepting a caller path, then checks the exact
three tmpfs options and sole read-only SQL bind in planned and actual mount
inspection records. Its frozen response only confirms the mount contract; it
does not confirm the container identity or grant cleanup authority.

`validateTrainingPostgresIsolation()` composes that network check with the
read-only prepared-artifact identity/lifecycle check and one bounded container
inspection. It confirms the registered image, labels, runtime state, root-readonly
and non-privileged flags, internal-network attachment, unpublished ports, exact
tmpfs options, and the sole read-only SQL bind. It rejects actual named/anonymous
volume mounts and unrelated mounts while allowing the image's declared PGDATA
volume metadata. Its frozen result contains only fixed ownership and safety
metadata; it grants no cleanup authority and does not constitute live Docker
evidence. The caller must serialize inspection against recovery finalization.

Before endpoint allocation, the created phase may report an explicitly empty
container endpoint `NetworkID` only when its `EndpointID` is also explicitly
empty and the inspected network has no members. Missing or malformed identities,
an allocated endpoint with an empty network ID, and any running endpoint without
matching non-empty member and container endpoint IDs are rejected. The exact
registered network ID remains accepted in either phase.

For the actual bind observation, `Mode` may be absent, empty, or exactly `ro`;
`RW` must still be `false`, and the planned mount must still be `ReadOnly: true`
with the exact owned source and destination. This accepts Docker 29.7.2's
structured read-only bind shape, which may report an empty `Mode`; the raw mode
from the historical failed inspection was not retained or confirmed. Writable,
compound, and unknown mode strings remain rejected.

The command planner also exposes fixed `inspect_network`,
`inspect_container`, and `server_version` operations. Resource inspection uses
one formatted JSON object for the ownership validators. The version probe uses
authenticated TCP to the owned container and bounds PostgreSQL statement and
lock time; it checks the server's numeric version rather than trusting image
metadata. `wait_ready` has both a bounded in-container retry loop and a bounded
client timeout. These are import-only plans and tests: they do not invoke Docker
or establish runtime isolation.

## Training-account PostgreSQL SQL receipts (import-only)

The assertion SQL emits one versioned, run-ID-bound text row only after each
successful top-level check or expected SQLSTATE rejection. Its final success
record follows both `ROLLBACK` and the post-rollback empty-table assertion.
`parseTrainingAccountSqlReceipt()` accepts only the exact 15-record order, fixed
checkpoint names/states, a zero numeric child exit status, and at most 8 KiB of
stdout. It returns frozen counts and fixed metadata without forwarding raw
output. The planned `psql` command uses quiet, tuples-only, unaligned output and
disables password prompting; it retains `ON_ERROR_STOP` and does not enable query
echoing. These import-only components structurally test the receipt protocol;
they do not establish PostgreSQL syntax, child-close, cleanup, or runtime proof.

Run the ordinary API checks with `npm --workspace @nina/api test` and
`npm --workspace @nina/api run lint`.

Pull requests and pushes to `feature/appointments` run the API checks and the
isolated PostgreSQL 15 regression suite in GitHub Actions. CI uses a temporary
hosted runner and pulls the test image there; the local suite below still
requires `postgres:15-alpine` to be present before running.

## Odontogram PostgreSQL 15 regression

Run `npm --workspace @nina/api run test:odontogram:postgres` to exercise the
real Prisma service and history migration against a temporary PostgreSQL 15
container. The runner uses only an already-cached `postgres:15-alpine` image;
it never pulls images or reads `.env` files or an ambient database URL.

The suite creates a uniquely labelled, per-run Docker bridge network with only
its PostgreSQL container attached, publishes an ephemeral host port only on
`127.0.0.1`, and keeps PostgreSQL data in container tmpfs. PostgreSQL trust
authentication is acceptable here only because unrelated containers are not
members of the dedicated network and the host binding is loopback; all records
are synthetic. The dedicated bridge permits outbound container traffic. The
network is not marked `--internal`: Docker did not expose the requested
loopback mapping from an internal network, and the host could not route to its
container IP. The runner verifies the exact container and network identities,
then removes only those owned resources in cleanup. It refuses to continue if
the image is absent, isolation checks fail, or cleanup cannot be asserted.

The migration test deploys predecessor migrations first, inserts one synthetic
legacy odontogram with a fixed timestamp, and then deploys the history
migration. The live Jest spec is gated by runner-created ownership evidence and
is not enabled by an arbitrary `DATABASE_URL`. The runner generates a separate
Prisma client from the copied temporary schema; its environment-file path stays
inside that temporary directory, where no `.env` file is created. Docker calls
have per-operation timeouts. If creation times out or a signal cancels the run,
cleanup reconciles only the unique per-run names with matching ownership labels
before deleting exact inspected IDs. Do not run the live spec directly against
another database.

The shared local subprocess runner trims successful decoded stdout by default.
An internal caller may set `preserveStdout: true` to receive that decoded string
unchanged, including whitespace and line endings; this does not promise raw-byte
preservation. The option must be a boolean and is captured once before spawning.
Nonzero exits, timeouts, cancellation, output bounds, and redacted error behavior
remain unchanged; failed-command stdout is never returned.

## Pharmacy partial-dispensing ledger

The additive dispensing migration records events (`PrescriptionDispensing`) for
a prescription and positive per-item/per-batch allocations
(`PrescriptionDispensingAllocation`). A prescription can have multiple events;
the unique event/item/batch tuple prevents duplicate lot rows within one event.
Indexes support prescription history and item/batch allocation lookups.

Database foreign keys require referenced records to exist and restrict their
deletion or identity changes while referenced. A SQL check requires allocation
quantity greater than zero. Row triggers reject ordinary `UPDATE` and `DELETE`
on both new tables. This is not administrator-proof protection: privileged
trigger bypass and `TRUNCATE` are not covered. The migration does not modify
existing records, prescription statuses, stock, or materialized counters, and
does not fabricate a legacy backfill.

`calculateDispensingBalance(prescribedQuantity, deliveredQuantities)` returns
`delivered` and `pending` for one item's **known, complete** allocation history.
It validates positive safe integers, rejects overdelivery without clamping,
and never mutates history. An empty complete history means zero delivered;
missing legacy history is not a complete history. In particular, an existing
`DISPENSED` prescription without ledger records has unknown delivery provenance,
not evidence of zero delivery or permission to dispense again.

Foreign keys and the pure balance helper do not enforce cross-record medication
matching, concurrent delivery limits, stock decreases or status transitions.
The internal service below owns those rules; Redis integration remains pending.
The ledger itself adds no endpoint, operator identity or RabbitMQ flow.

### Internal transactional dispensing

`PharmacyDispensingService.dispenseItem({ prescriptionId, itemId, quantity,
eventId })` delivers exactly one requested positive portion or rejects it.
The caller supplies a UUID event ID (matched as an exact, case-sensitive string)
and the medication is derived from the stored prescription item. Under the
operating contract that all deliveries are recorded in NINA, an empty `ISSUED`
ledger is complete zero history. Unknown imported history requires reconciliation;
there is no implicit import or backfill. New terminal-state deliveries reject.

A ReadCommitted Prisma transaction locks the prescription, validates complete
history across all its items, and locks medication batches in deterministic ID
order. Expiry is evaluated after acquiring batch locks. Conditional stock
decrements, event/allocations and prescription status commit together: partial
delivery stays `ISSUED`, and completion of every item becomes `DISPENSED`.
Prescription and batch row locks, not a Redis lease, own database serialization.

An exact successful event replay is allowed before terminal-state rejection and
returns recorded allocations without writes. Reusing an event ID for a different
prescription, item or quantity rejects; a concurrent global ID collision escapes
the transaction without blind retry. No historical balance snapshot is invented.
Mock tests verify orchestration and failure propagation, not PostgreSQL rollback
or concurrency. See the isolated database proof below. Redis runtime proof,
module registration and HTTP endpoints remain pending; neither service is yet
exposed by the application.

### Internal Redis admission facade (not registered)

`LockedPharmacyDispensingService` validates the request before Redis, then acquires
a prescription-scoped lease with a fresh owner UUID per attempt (not the event
UUID). The exact prescription ID is JSON-encoded without normalization. Busy
leases reject with 409; connection/command errors or unexpected replies reject
with a sanitized 503 before any transactional call. On acquisition, the facade
delegates once and preserves the exact transaction result or original error.

`PharmacyLockService` uses pharmacy-owned `PHARMACY_REDIS`, lazy coalesced connects,
bounded 1.5-second sockets/commands and `SET NX PX` with a ten-second lease. Its
explicit-URL factory reads no environment and never connects eagerly. Finally
release uses owner-checked Lua; an expired predecessor cannot delete a successor's
lease, and release failure logs only a fixed warning without masking the outcome.
Shutdown destroys only its opened client. Module/configuration/API registration
and actual Redis runtime proof remain pending. Dependency-double tests are not
live Redis evidence. PostgreSQL row locks, stock checks and event uniqueness remain
the correctness authority if a transaction outlives its Redis lease.

### Redis proof guard foundation (unwired)

`verify-pharmacy-redis-runtime.cjs` is import-only. It validates private0700/0600
owned canonical proof/config paths, exact authentication/persistence settings,
credential-bearing loopback URL and explicit Docker identity/network observations.
The contract requires one labelled Redis7 container, an unprivileged current UID,
readonly root/config, tmpfs data and no unrelated mounts or network members.
Privileged mode must be explicitly disabled.
Rejected values are never included in guard diagnostics.

It does not discover environment configuration, inspect Docker, import Redis or
load the compiled adapter. Fixture tests establish guard behavior, not live Redis
proof. A future owned orchestrator must obtain observations from the pinned local
socket before loading any client.

`verify-pharmacy-redis-lease.cjs` is an import-only assertion component. It accepts
explicit caller-owned client/service instances and a fixture key; it constructs
no client, loads no adapter and discovers no URL or environment configuration.
Assertions cover Redis7, NX/PX10000, owner-safe Lua, bounded natural expiry and
successor preservation. Its dependency-double tests do not establish live Redis
proof. Disposable orchestration and actual runtime execution remain unwired.

`verify-pharmacy-redis-scenarios.cjs` is the guarded scenario child, not an
orchestrator. Explicit run UUID/private proof arguments bind exact-ID observations
obtained internally through the pinned socket. Existing guards run before the
canonical compiled adapter is loaded or any client is created; only then does the
child delegate to the lease assertions with its owned instances. Finally destroys
all opened clients, including partial startup failures; CLI errors are generic.
The disposable runner invokes this child. VM startup tests are safety evidence,
not live Redis proof.

`pharmacy-redis-resource-identity.cjs` is an import-only context/observation
contract. It checks canonical private-root/run/image inputs, exact Redis resource
names/labels/image identity and target-specific absence errors. These predicates
neither inspect Docker nor grant removal authority. Its shared synthetic fixture
creates only an empty private directory and metadata, never authentication files.
Creation tracking and reconciliation use these contracts; actual runtime proof remains pending.

`pharmacy-redis-resources.cjs` supplies an opaque run/image/private-root tracker.
The future orchestrator wraps its bounded create operation with `captureCreation`
so uncertainty is registered before awaiting Docker output. Cleanup internally
inspects only exact known IDs or the fresh UUID-bound name through the pinned
socket, verifies Redis ownership/image identity and removes the container before
an empty owned network. Created/stopped fixtures are valid cleanup targets;
foreign members, ambiguous errors and unproved absence fail closed. Cleanup has
its own bounded deadline, independent of an aborted creation signal. Unit executor
doubles establish these state transitions, not disposable Docker cleanup proof.

### Disposable Redis verification

The import-only `pharmacy-redis-runner-fixture.cjs` prepares private authentication,
proof files and fixed creation arguments. It does not execute Docker, load clients
or grant connection authority; the orchestrator owns those guarded operations.

`npm run test:pharmacy:redis --workspace=@nina/api` builds the actual adapter and
runs `verify-pharmacy-redis.cjs --isolated`. Run it only with authorization for
fresh local disposable Redis resources and their own loopback connections.
The runner requires the pinned cached `redis:7-alpine` image; it never pulls.
Private0700 storage contains only two0600 files with fresh authentication/proof.
The owned UID/GID, readonly config/root, ephemeral data, dropped capabilities,
explicit loopback port and dedicated labelled network must pass existing guards
before readiness clients or the guarded scenario child can connect.

SIGINT/SIGTERM and deadlines settle bounded subprocesses before independent
ownership-checked cleanup. Overall PASS requires exact resource absence;
uncertain cleanup retains private recovery files and fails. No existing services,
ambient credentials, PostgreSQL, application configuration or endpoints are used.
The orchestrator's VM tests are not live proof: actual Redis7/ten-second expiry
and disposable cleanup still require a separately authorized real run.

### Calendar-date batch expiry

`isBatchExpired(expirationLabel, evaluationInstant)` is a pure policy helper.
Supply a real, canonical `YYYY-MM-DD` Gregorian label and a finite `Date` instant.
Four-digit proleptic Gregorian years include `0000`; malformed labels and
impossible dates are rejected rather than normalized.

A batch remains valid throughout its indicated date in `America/Santiago` and
expires only when the evaluation instant's local calendar date is later. The
helper uses explicit Gregorian/Latin-numbered ICU timezone data, not server
timezone, a fixed UTC offset, or a 24-hour duration. Clock changes may repeat
hours or skip midnight without changing this calendar-date rule.

The expiry predicate does not interpret stored timestamps or select stock.
`prepareEligibleBatches(batches, medicationId, evaluationInstant)` provides a pure
allocator-input projection for the confirmed calendar-date storage convention:
finite `Batch.expirationDate` values must encode a four-digit Gregorian date at
UTC midnight. Their UTC label is preserved, never shifted into Santiago's previous
date. Non-midnight, invalid and out-of-range timestamps are rejected, not repaired
or rewritten in the database.

The projection validates the evaluation instant even for empty input, medication
identities, and every relevant batch's ID, unique ID, safe nonnegative stock and
date encoding before filtering matching medication, positive stock and nonexpired
dates. Records belonging to other valid medication IDs are ignored without
examining their remaining fields. IDs are matched exactly, not trimmed or normalized.
Results preserve input order and clone dates; `allocateStock` handles chronological
ordering, ordinal-ID ties and insufficient-stock rejection. No stock is mutated.
The internal service composes this projection inside its locked transaction;
isolated runtime verification and application integration remain pending.

### Isolated PostgreSQL 15 ledger proof

For the real internal service baseline, run
`npm run test:pharmacy:dispensing:postgres --workspace=@nina/api`. It builds first
and selects a separate authenticated `pharmacy-dispensing` mode using the same
owned-resource lifecycle. A guarded child rechecks private proof/client paths,
datasource binding, exact resource labels/image/loopback mapping and sole network
membership before constructing real temporary Prisma clients. Direct and
transitive service imports bind only to that isolated generated client.

The baseline calls the actual compiled service for three requested portions,
checks partial/full status across two items and exact stock/history, and rejects
expired-only stock without mutation. It additionally proves exact replay after
terminal completion and rejects changed quantity/item/prescription keys, comparing
deterministic full-row snapshots of patients, medications, batches, prescriptions,
items, events and allocations after every call.

A fixture-only allocation trigger first checks that its transaction sees the
expected stock decrement, then raises `PHARMACY_PROOF_ROLLBACK_STOCK_VISIBLE`.
The actual service must propagate that marker and leave the complete snapshot
unchanged, with no failed event. Trigger/function cleanup runs in `finally`; their
absence and a successful retry using the same event ID prove recovery. The printed
baseline summary remains compatible with the shared runner and is emitted only
after these extra assertions pass.

The contention proof holds a real prescription or shared batch row lock while two
separate, single-connection clients call the actual service. It observes both
writer backend PID/start identities actively waiting in the expected `FOR UPDATE`
query, with blocker paths reaching the held backend (including soft queueing
through the peer). Only that observation releases the gate; polling is not timing
proof. Same-prescription requests cannot exceed pending quantity, and different
prescriptions cannot overdraw shared stock. Exact outcomes, recorded allocations,
stock, statuses and loser history are asserted. Observation has a three-second
deadline and monitor statements are bounded; fixture clients alone use a
15-second transaction timeout. Finally releases gates, settles launched work and
disconnects all clients. Concurrent identical requests also queue at the held
prescription row, then return identical recorded results with only one stock
decrement/event/allocation and terminal status. Different prescriptions sharing
one event UUID queue at the held batch after both absent replay lookups; stock is
sufficient for both requests. Exactly one native Prisma `P2002` rejection must
identify model `PrescriptionDispensing` and target `["id"]`. Only the winner's
delivery persists; the loser's stock decrement rolls back and its prescription,
items and history remain unchanged. Assertion/observer unit tests alone do not
prove database concurrency.
The suite does not expose an endpoint or use Redis.
Both existing modes remain available unchanged; never invoke the child directly
with an ambient datasource or bypass its runner-issued ownership checks.

Run `npm run test:pharmacy:postgres --workspace=@nina/api` with an already-cached
`postgres:15-alpine` image and local Docker. It reuses the owned-resource runner;
no arguments still selects the unchanged odontogram suite. Unknown arguments
fail before resource creation. No real or ambient database is used.

The pharmacy suite creates random database/user/password values, passes them in
an exclusive mode-0600 temporary env-file and uses SCRAM host authentication.
Passwords and the generated datasource are redacted from subprocess failures;
credentials never appear in argv or saved proof output. Temporary storage and
only exact inspected, labelled run-owned container/network IDs are cleaned up.
The dedicated bridge permits outbound traffic; the published host port is
loopback-only, data is tmpfs and image pulls remain disabled.

Predecessor migrations deploy first; synthetic ISSUED, DISPENSED and CANCELLED
prescriptions are snapshotted with quantities, stock and timestamps. After the
ledger migration, the snapshot must match and both ledger tables must be empty.
SQL scenarios check successful multiple events/default timestamps, four specific
FKs, zero/negative quantity checks, duplicate tuples, both tables' UPDATE/DELETE
triggers and referenced parents' DELETE/identity restrictions. Every rejection
checks its SQLSTATE/constraint (or exact trigger message) and unchanged history.
To prove the event-to-allocation FK separately from its masking append-only
trigger, only that trigger is disabled inside a rolled-back fixture transaction;
its restored guard is then checked again.

This proves migration constraints, not cross-medication/prescription matching,
expiry eligibility, service transactions, concurrency or administrator resistance.
The existing deterministic helper tests and offline Prisma checks remain useful;
run the isolated command before claiming live database proof.

## Training-account PostgreSQL proof command

Build the API before using this command so fixture preparation can load the
compiled password hasher. Help is inert; review the invocation before requesting
a separately authorized isolated run:

```sh
npm run build --workspace=@nina/api
npm run training-accounts:postgres --workspace=@nina/api -- --help
npm run training-accounts:postgres --workspace=@nina/api -- --run-isolated
```

Only the exact `--run-isolated` option starts the proof runtime. It uses the
cached PostgreSQL 15 image through the local Docker daemon, creates an isolated
synthetic-account fixture, and cleans up only resources its recovery checks
confirm as owned. Private proof credentials remain in private fixture artifacts;
command output is limited to fixed status and validated outcome booleans.
Incomplete proof or cleanup retains recovery evidence. The command does not
target an existing application database. Do not claim live proof unless the
separately authorized run completes with proof and owned cleanup both confirmed.
