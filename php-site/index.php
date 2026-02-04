<?php
declare(strict_types=1);

$exampleVersion = null;
$exampleCentralStatsUrl = null;
if (file_exists(__DIR__ . '/config.example.php')) {
    $exampleConfig = require __DIR__ . '/config.example.php';
    if (is_array($exampleConfig)) {
        if (array_key_exists('site_version', $exampleConfig)) {
            $exampleVersion = trim((string)($exampleConfig['site_version'] ?? ''));
        }
        if (array_key_exists('central_stats_url', $exampleConfig)) {
            $exampleCentralStatsUrl = trim((string)($exampleConfig['central_stats_url'] ?? ''));
        }
    }
}

$config = [
    'app_name' => '思源笔记分享',
    'site_version' => '',
    'central_stats_url' => '',
    'db_path' => __DIR__ . '/storage/app.db',
    'uploads_dir' => __DIR__ . '/uploads',
    'allow_registration' => true,
    'default_storage_limit_mb' => 1024,
    'session_lifetime_days' => 30,
    'chunk_ttl_seconds' => 7200,
    'chunk_cleanup_probability' => 0.05,
    'chunk_cleanup_limit' => 20,
    'min_chunk_size_kb' => 256,
    'max_chunk_size_mb' => 8,
    'captcha_enabled' => true,
    'email_verification_enabled' => false,
    'email_from' => 'no-reply@example.com',
    'email_from_name' => '思源笔记分享',
    'email_subject' => '邮箱验证码',
    'email_reset_subject' => '重置密码验证码',
    'smtp_enabled' => false,
    'smtp_host' => '',
    'smtp_port' => 587,
    'smtp_secure' => 'tls',
    'smtp_user' => '',
    'smtp_pass' => '',
];

if (file_exists(__DIR__ . '/config.php')) {
    $local = require __DIR__ . '/config.php';
    if (is_array($local)) {
        $config = array_merge($config, $local);
    }
}
if ($exampleVersion !== null) {
    $config['site_version'] = $exampleVersion;
}
if ($exampleCentralStatsUrl !== null) {
    $config['central_stats_url'] = $exampleCentralStatsUrl;
}

$sessionDays = (int)($config['session_lifetime_days'] ?? 30);
if ($sessionDays <= 0) {
    $sessionDays = 30;
}
$sessionLifetime = $sessionDays * 86400;
ini_set('session.gc_maxlifetime', (string)$sessionLifetime);
ini_set('session.cookie_lifetime', (string)$sessionLifetime);
session_set_cookie_params($sessionLifetime, '/', '', false, true);
session_start();
date_default_timezone_set('UTC');

if (function_exists('date_default_timezone_set')) {
    date_default_timezone_set('Asia/Shanghai');
}

require_once __DIR__ . '/vendor/Parsedown.php';

function base_path(): string {
    $script = $_SERVER['SCRIPT_NAME'] ?? '';
    $dir = str_replace('\\', '/', dirname($script));
    $dir = rtrim($dir, '/');
    return $dir === '/' ? '' : $dir;
}

function base_url(): string {
    static $customBaseUrl = null;
    if ($customBaseUrl === null) {
        $customBaseUrl = trim((string)get_setting('site_base_url', ''));
        if ($customBaseUrl !== '') {
            $customBaseUrl = rtrim($customBaseUrl, '/');
        }
    }
    if ($customBaseUrl !== null && $customBaseUrl !== '') {
        return $customBaseUrl;
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    return $scheme . '://' . $host . base_path();
}

function redirect(string $path): void {
    header('Location: ' . base_path() . $path);
    exit;
}

function enqueue_background_task(callable $task): void {
    register_shutdown_function(function () use ($task) {
        if (function_exists('fastcgi_finish_request')) {
            @fastcgi_finish_request();
        }
        $task();
    });
}

function now(): string {
    return date('Y-m-d H:i:s');
}

function db(): PDO {
    static $pdo = null;
    global $config;
    if ($pdo) {
        return $pdo;
    }
    $dbDir = dirname($config['db_path']);
    if (!is_dir($dbDir)) {
        mkdir($dbDir, 0775, true);
    }
    $dsn = 'sqlite:' . $config['db_path'];
    $pdo = new PDO($dsn);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('PRAGMA foreign_keys = ON;');
    migrate($pdo);
    return $pdo;
}

function migrate(PDO $pdo): void {
    $pdo->exec('CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT "user",
        api_key_hash TEXT,
        api_key_prefix TEXT,
        api_key_last4 TEXT,
        disabled INTEGER NOT NULL DEFAULT 0,
        storage_limit_bytes INTEGER NOT NULL DEFAULT 0,
        storage_used_bytes INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        email_verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        doc_id TEXT,
        notebook_id TEXT,
        password_hash TEXT,
        expires_at INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0,
        visitor_limit INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS share_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        share_id INTEGER NOT NULL,
        doc_id TEXT NOT NULL,
        title TEXT NOT NULL,
        icon TEXT,
        hpath TEXT,
        parent_id TEXT,
        sort_index INTEGER NOT NULL DEFAULT 0,
        markdown TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(share_id) REFERENCES shares(id)
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS share_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        share_id INTEGER NOT NULL,
        doc_id TEXT,
        asset_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(share_id, asset_path),
        FOREIGN KEY(share_id) REFERENCES shares(id)
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS share_uploads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upload_id TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL,
        share_id INTEGER,
        type TEXT NOT NULL,
        doc_id TEXT,
        notebook_id TEXT,
        slug TEXT,
        title TEXT,
        password_hash TEXT,
        expires_at INTEGER,
        visitor_limit INTEGER NOT NULL DEFAULT 0,
        asset_manifest TEXT,
        status TEXT NOT NULL DEFAULT "pending",
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(share_id) REFERENCES shares(id)
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS share_upload_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upload_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        title TEXT NOT NULL,
        icon TEXT,
        hpath TEXT,
        parent_id TEXT,
        sort_index INTEGER NOT NULL DEFAULT 0,
        markdown TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS user_settings (
        user_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, key),
        FOREIGN KEY(user_id) REFERENCES users(id)
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS share_access_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        share_id INTEGER NOT NULL,
        doc_id TEXT,
        doc_title TEXT,
        visitor_id TEXT,
        ip TEXT,
        ip_country TEXT,
        ip_country_code TEXT,
        ip_region TEXT,
        ip_city TEXT,
        referer TEXT,
        created_at TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(share_id) REFERENCES shares(id)
    );');

    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_share_access_user_time ON share_access_logs (user_id, created_at)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_share_access_share_time ON share_access_logs (share_id, created_at)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_share_access_visitor_time ON share_access_logs (visitor_id, created_at)');

    $pdo->exec('CREATE TABLE IF NOT EXISTS share_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        share_id INTEGER NOT NULL,
        parent_id INTEGER,
        user_id INTEGER,
        visitor_id TEXT,
        email TEXT NOT NULL,
        content TEXT NOT NULL,
        ip TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(share_id) REFERENCES shares(id)
    );');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_share_comments_share ON share_comments (share_id, created_at)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_share_comments_parent ON share_comments (parent_id)');

    $pdo->exec('CREATE TABLE IF NOT EXISTS share_visitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        share_id INTEGER NOT NULL,
        visitor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(share_id, visitor_id),
        FOREIGN KEY(share_id) REFERENCES shares(id)
    );');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_share_visitors_share ON share_visitors (share_id)');

    $pdo->exec('CREATE TABLE IF NOT EXISTS share_access_geo_cache (
        ip TEXT PRIMARY KEY,
        country TEXT,
        country_code TEXT,
        region TEXT,
        city TEXT,
        updated_at TEXT NOT NULL
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS share_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        share_id INTEGER NOT NULL,
        share_title TEXT NOT NULL,
        share_slug TEXT NOT NULL,
        share_user_id INTEGER NOT NULL,
        reporter_user_id INTEGER,
        report_email TEXT,
        visitor_id TEXT,
        ip TEXT,
        reason_type TEXT NOT NULL,
        reason_detail TEXT,
        created_at TEXT NOT NULL,
        handled_at TEXT,
        handled_by INTEGER,
        FOREIGN KEY(share_id) REFERENCES shares(id)
    );');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_share_reports_share ON share_reports (share_id, created_at)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_share_reports_handled ON share_reports (handled_at)');

    $pdo->exec('CREATE TABLE IF NOT EXISTS instance_heartbeats (
        instance_id TEXT PRIMARY KEY,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        version TEXT,
        ip TEXT
    );');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_instance_heartbeats_seen ON instance_heartbeats (last_seen)');

    $pdo->exec('CREATE TABLE IF NOT EXISTS recycled_share_ids (
        share_id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(created_by) REFERENCES users(id)
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS email_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT,
        ip TEXT
    );');

    $pdo->exec('CREATE TABLE IF NOT EXISTS password_resets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT,
        ip TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );');

    ensure_column($pdo, 'users', 'storage_limit_bytes', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'users', 'storage_used_bytes', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'users', 'last_active_at', 'TEXT');
    ensure_column($pdo, 'shares', 'password_hash', 'TEXT');
    ensure_column($pdo, 'shares', 'expires_at', 'INTEGER');
    ensure_column($pdo, 'shares', 'access_count', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'shares', 'visitor_limit', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'shares', 'size_bytes', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'shares', 'comment_notify', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'share_reports', 'report_email', 'TEXT');
    ensure_column($pdo, 'share_uploads', 'visitor_limit', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'share_upload_docs', 'icon', 'TEXT');
    ensure_column($pdo, 'share_docs', 'size_bytes', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'share_docs', 'icon', 'TEXT');
    ensure_column($pdo, 'share_docs', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'share_docs', 'parent_id', 'TEXT');
    ensure_column($pdo, 'share_docs', 'sort_index', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'share_assets', 'size_bytes', 'INTEGER NOT NULL DEFAULT 0');

    seed_default_settings($pdo);
    seed_default_admin($pdo);
}

function table_has_column(PDO $pdo, string $table, string $column): bool {
    $stmt = $pdo->query('PRAGMA table_info(' . $table . ')');
    $cols = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
    foreach ($cols as $col) {
        if (isset($col['name']) && $col['name'] === $column) {
            return true;
        }
    }
    return false;
}

function ensure_column(PDO $pdo, string $table, string $column, string $definition): void {
    if (!table_has_column($pdo, $table, $column)) {
        $pdo->exec('ALTER TABLE ' . $table . ' ADD COLUMN ' . $column . ' ' . $definition);
    }
}

function fetch_setting(PDO $pdo, string $key): ?string {
    $stmt = $pdo->prepare('SELECT value FROM settings WHERE key = :key LIMIT 1');
    $stmt->execute([':key' => $key]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ? $row['value'] : null;
}

function ensure_setting(PDO $pdo, string $key, string $value): void {
    $existing = fetch_setting($pdo, $key);
    if ($existing !== null) {
        return;
    }
    $stmt = $pdo->prepare('INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :updated_at)');
    $stmt->execute([
        ':key' => $key,
        ':value' => $value,
        ':updated_at' => now(),
    ]);
}

function seed_default_settings(PDO $pdo): void {
    global $config;
    $defaultLimit = (int)$config['default_storage_limit_mb'] * 1024 * 1024;
    ensure_setting($pdo, 'allow_registration', $config['allow_registration'] ? '1' : '0');
    ensure_setting($pdo, 'default_storage_limit_bytes', (string)$defaultLimit);
    ensure_setting($pdo, 'captcha_enabled', $config['captcha_enabled'] ? '1' : '0');
    ensure_setting($pdo, 'email_verification_enabled', $config['email_verification_enabled'] ? '1' : '0');
    ensure_setting($pdo, 'email_from', (string)$config['email_from']);
    ensure_setting($pdo, 'email_from_name', (string)$config['email_from_name']);
    ensure_setting($pdo, 'email_subject', (string)$config['email_subject']);
    ensure_setting($pdo, 'email_reset_subject', (string)$config['email_reset_subject']);
    ensure_setting($pdo, 'smtp_enabled', $config['smtp_enabled'] ? '1' : '0');
    ensure_setting($pdo, 'smtp_host', (string)$config['smtp_host']);
    ensure_setting($pdo, 'smtp_port', (string)$config['smtp_port']);
    ensure_setting($pdo, 'smtp_secure', (string)$config['smtp_secure']);
    ensure_setting($pdo, 'smtp_user', (string)$config['smtp_user']);
    ensure_setting($pdo, 'smtp_pass', (string)$config['smtp_pass']);
    ensure_setting($pdo, 'banned_words', '');
    ensure_setting($pdo, 'site_icp', '');
    ensure_setting($pdo, 'site_contact_email', '');
    ensure_setting($pdo, 'site_base_url', '');
    ensure_setting($pdo, 'access_stats_default_enabled', '1');
    ensure_setting($pdo, 'access_stats_default_retention_days', '7');
}

function seed_default_admin(PDO $pdo): void {
    $count = (int)$pdo->query('SELECT COUNT(*) AS cnt FROM users')->fetchColumn();
    if ($count > 0) {
        return;
    }
    $now = now();
    $stmt = $pdo->prepare('INSERT INTO users (username, email, password_hash, role, api_key_hash, api_key_prefix, api_key_last4, disabled, storage_limit_bytes, storage_used_bytes, must_change_password, email_verified, created_at, updated_at)
        VALUES (:username, :email, :password_hash, :role, :api_key_hash, :api_key_prefix, :api_key_last4, :disabled, :storage_limit_bytes, :storage_used_bytes, :must_change_password, :email_verified, :created_at, :updated_at)');
    $stmt->execute([
        ':username' => 'admin',
        ':email' => '',
        ':password_hash' => password_hash('123456', PASSWORD_DEFAULT),
        ':role' => 'admin',
        ':api_key_hash' => null,
        ':api_key_prefix' => null,
        ':api_key_last4' => null,
        ':disabled' => 0,
        ':storage_limit_bytes' => 0,
        ':storage_used_bytes' => 0,
        ':must_change_password' => 1,
        ':email_verified' => 1,
        ':created_at' => $now,
        ':updated_at' => $now,
    ]);
}

function csrf_token(): string {
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(16));
    }
    return $_SESSION['csrf'];
}

function check_csrf(): void {
    $token = $_POST['csrf'] ?? '';
    if (!$token || !hash_equals($_SESSION['csrf'] ?? '', $token)) {
        http_response_code(400);
        echo 'CSRF 校验失败。';
        exit;
    }
}

function flash(string $key, ?string $value = null): ?string {
    if ($value !== null) {
        $_SESSION['flash'][$key] = $value;
        return null;
    }
    $val = $_SESSION['flash'][$key] ?? null;
    if (isset($_SESSION['flash'][$key])) {
        unset($_SESSION['flash'][$key]);
    }
    return $val;
}

function get_setting(string $key, ?string $default = null): ?string {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT value FROM settings WHERE key = :key LIMIT 1');
    $stmt->execute([':key' => $key]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row && array_key_exists('value', $row)) {
        return $row['value'];
    }
    return $default;
}

function set_setting(string $key, string $value): void {
    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :updated_at)
        ON CONFLICT(key) DO UPDATE SET value = :value_update, updated_at = :updated_at_update');
    $stmt->execute([
        ':key' => $key,
        ':value' => $value,
        ':updated_at' => now(),
        ':value_update' => $value,
        ':updated_at_update' => now(),
    ]);
}

function get_bool_setting(string $key, bool $default = false): bool {
    $value = get_setting($key, $default ? '1' : '0');
    return (int)$value === 1;
}

function get_user_setting(int $userId, string $key, ?string $default = null): ?string {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT value FROM user_settings WHERE user_id = :uid AND key = :key LIMIT 1');
    $stmt->execute([
        ':uid' => $userId,
        ':key' => $key,
    ]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row && array_key_exists('value', $row)) {
        return $row['value'];
    }
    return $default;
}

function set_user_setting(int $userId, string $key, string $value): void {
    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES (:uid, :key, :value, :updated_at)
        ON CONFLICT(user_id, key) DO UPDATE SET value = :value_update, updated_at = :updated_at_update');
    $stmt->execute([
        ':uid' => $userId,
        ':key' => $key,
        ':value' => $value,
        ':updated_at' => now(),
        ':value_update' => $value,
        ':updated_at_update' => now(),
    ]);
}

function access_stats_default_enabled(): bool {
    return get_bool_setting('access_stats_default_enabled', true);
}

function access_stats_default_retention_days(): int {
    $raw = (int)get_setting('access_stats_default_retention_days', '7');
    return max(1, min(365, $raw));
}

function access_stats_enabled(int $userId): bool {
    $value = get_user_setting($userId, 'access_stats_enabled', null);
    if ($value === null) {
        return access_stats_default_enabled();
    }
    return (int)$value === 1;
}

function access_stats_retention_days(int $userId): int {
    $value = get_user_setting($userId, 'access_stats_retention_days', null);
    if ($value === null) {
        return access_stats_default_retention_days();
    }
    $days = (int)$value;
    return max(1, min(365, $days));
}

function allow_registration(): bool {
    return get_bool_setting('allow_registration', true);
}

function captcha_enabled(): bool {
    return get_bool_setting('captcha_enabled', true);
}

function email_verification_enabled(): bool {
    return get_bool_setting('email_verification_enabled', false);
}

function smtp_enabled(): bool {
    return get_bool_setting('smtp_enabled', false);
}

function email_verification_available(): bool {
    return email_verification_enabled() && smtp_enabled();
}

function default_storage_limit_bytes(): int {
    $value = (int)get_setting('default_storage_limit_bytes', '0');
    return max(0, $value);
}

function get_banned_words_raw(): string {
    return (string)get_setting('banned_words', '');
}

function get_banned_words(): array {
    $raw = get_banned_words_raw();
    if ($raw === '') {
        return [];
    }
    $parts = array_map('trim', explode('|', $raw));
    return array_values(array_filter($parts, fn($word) => $word !== ''));
}

function string_pos_ci(string $text, string $needle): ?int {
    if (function_exists('mb_stripos')) {
        $pos = mb_stripos($text, $needle, 0, 'UTF-8');
        return $pos === false ? null : (int)$pos;
    }
    $pos = stripos($text, $needle);
    return $pos === false ? null : (int)$pos;
}

function string_len(string $text): int {
    if (function_exists('mb_strlen')) {
        return (int)mb_strlen($text, 'UTF-8');
    }
    return strlen($text);
}

function string_sub(string $text, int $start, int $length): string {
    if (function_exists('mb_substr')) {
        return (string)mb_substr($text, $start, $length, 'UTF-8');
    }
    return substr($text, $start, $length);
}

function find_banned_word(string $text, array $words): ?array {
    foreach ($words as $word) {
        if ($word === '') {
            continue;
        }
        $pos = string_pos_ci($text, $word);
        if ($pos !== null) {
            return ['word' => $word, 'pos' => $pos];
        }
    }
    return null;
}

function normalize_plain_text(string $text): string {
    $text = preg_replace('/\R+/u', ' ', $text);
    $text = preg_replace('/\s+/u', ' ', $text);
    return trim((string)$text);
}

function extract_snippet(string $text, string $word, int $radius = 40): string {
    $plain = normalize_plain_text($text);
    if ($plain === '') {
        return '';
    }
    $pos = string_pos_ci($plain, $word);
    if ($pos === null) {
        return string_sub($plain, 0, min(120, string_len($plain)));
    }
    $start = max(0, $pos - $radius);
    $length = min(string_len($plain) - $start, $radius * 2 + string_len($word));
    return string_sub($plain, $start, $length);
}

function parse_expires_at($raw): ?int {
    if ($raw === null || $raw === '' || $raw === false) {
        return null;
    }
    if (is_numeric($raw)) {
        $ts = (int)$raw;
        if ($ts > 1000000000000) {
            $ts = (int)floor($ts / 1000);
        }
        return $ts > 0 ? $ts : null;
    }
    $ts = strtotime((string)$raw);
    return $ts ? $ts : null;
}

function parse_visitor_limit($raw): ?int {
    if ($raw === null || $raw === '' || $raw === false) {
        return null;
    }
    if (is_numeric($raw)) {
        return max(0, (int)$raw);
    }
    return null;
}

function extract_front_matter(string $markdown): array {
    $meta = [];
    $body = $markdown;
    if (preg_match('/\A---\s*\R(.*?)\R---\s*\R/s', $markdown, $matches)) {
        $raw = trim((string)$matches[1]);
        $body = substr($markdown, strlen($matches[0]));
        foreach (preg_split('/\R/', $raw) as $line) {
            if (strpos($line, ':') === false) {
                continue;
            }
            [$key, $value] = array_map('trim', explode(':', $line, 2));
            if ($key === '') {
                continue;
            }
            $meta[strtolower($key)] = trim($value, " \t\"'");
        }
    }
    return ['meta' => $meta, 'body' => $body];
}

function format_meta_date(?string $raw): string {
    if (!$raw) {
        return '';
    }
    $ts = strtotime($raw);
    if ($ts) {
        return date('Y-m-d H:i', $ts);
    }
    return $raw;
}

function render_meta_chips(array $meta): string {
    $created = $meta['date'] ?? $meta['created'] ?? $meta['created_at'] ?? '';
    $updated = $meta['lastmod'] ?? $meta['updated'] ?? $meta['modified'] ?? $meta['last_modified'] ?? '';
    $chips = [];
    if ($created !== '') {
        $chips[] = ['label' => '创建', 'value' => format_meta_date($created)];
    }
    if ($updated !== '') {
        $chips[] = ['label' => '更新', 'value' => format_meta_date($updated)];
    }
    if (empty($chips)) {
        return '';
    }
    $html = '<div class="kb-meta">';
    foreach ($chips as $chip) {
        $label = htmlspecialchars($chip['label']);
        $value = htmlspecialchars($chip['value']);
        $html .= "<span class=\"kb-chip\"><strong>{$label}</strong> {$value}</span>";
    }
    $html .= '</div>';
    return $html;
}

function format_share_datetime(?string $raw): string {
    if (!$raw) {
        return '';
    }
    $ts = strtotime($raw);
    if ($ts) {
        return date('Y-m-d H:i', $ts);
    }
    return $raw;
}

function mask_email(string $email): string {
    $email = trim($email);
    if ($email === '') {
        return '';
    }
    $parts = explode('@', $email, 2);
    if (count($parts) !== 2) {
        return str_repeat('*', max(2, strlen($email)));
    }
    [$local, $domain] = $parts;
    $local = trim($local);
    if ($local === '') {
        return str_repeat('*', 3) . '@' . $domain;
    }
    $len = strlen($local);
    if ($len <= 1) {
        $masked = $local . '**';
    } else {
        $maskLen = max(1, (int)floor($len / 2));
        $keepLen = $len - $maskLen;
        $keepStart = max(1, (int)ceil($keepLen / 2));
        $keepEnd = max(1, $keepLen - $keepStart);
        if ($keepStart + $keepEnd >= $len) {
            $keepStart = 1;
            $keepEnd = $len > 1 ? 1 : 0;
        }
        $masked = substr($local, 0, $keepStart)
            . str_repeat('*', $len - $keepStart - $keepEnd)
            . substr($local, $len - $keepEnd);
    }
    return $masked . '@' . $domain;
}

function calculate_comment_size(string $email, string $content): int {
    $size = strlen($email) + strlen($content);
    return max(1, $size);
}

function share_comment_size(int $shareId): int {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM share_comments WHERE share_id = :share_id');
    $stmt->execute([':share_id' => $shareId]);
    return (int)$stmt->fetchColumn();
}

function comment_asset_prefix(): string {
    return 'comment-files/';
}

function share_comment_asset_size(int $shareId): int {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM share_assets WHERE share_id = :share_id AND asset_path LIKE :prefix');
    $stmt->execute([
        ':share_id' => $shareId,
        ':prefix' => comment_asset_prefix() . '%',
    ]);
    return (int)$stmt->fetchColumn();
}

function extract_comment_asset_paths(string $content, int $shareId): array {
    $content = trim($content);
    if ($content === '') {
        return [];
    }
    $prefix = comment_asset_prefix() . $shareId . '/';
    $pattern = "#uploads/" . preg_quote($prefix, '#') . "([^\\s\\)\"'<>]+)#i";
    if (!preg_match_all($pattern, $content, $matches)) {
        return [];
    }
    $paths = [];
    foreach ($matches[1] as $suffix) {
        $suffix = preg_replace('/[?#].*$/', '', $suffix);
        $path = sanitize_asset_path($prefix . $suffix);
        if ($path === '') {
            continue;
        }
        $paths[$path] = true;
    }
    return array_keys($paths);
}

function filter_unused_comment_assets(int $shareId, array $paths, array $excludeIds): array {
    if (empty($paths)) {
        return [];
    }
    $pdo = db();
    $unused = [];
    foreach ($paths as $path) {
        $needle = 'uploads/' . ltrim($path, '/');
        $sql = 'SELECT COUNT(*) FROM share_comments WHERE share_id = ? AND content LIKE ?';
        $params = [$shareId, '%' . $needle . '%'];
        if (!empty($excludeIds)) {
            $sql .= ' AND id NOT IN (' . implode(',', array_fill(0, count($excludeIds), '?')) . ')';
            $params = array_merge($params, $excludeIds);
        }
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $count = (int)$stmt->fetchColumn();
        if ($count <= 0) {
            $unused[] = $path;
        }
    }
    return $unused;
}

function sum_share_asset_sizes(int $shareId, array $paths): int {
    if (empty($paths)) {
        return 0;
    }
    $placeholders = implode(',', array_fill(0, count($paths), '?'));
    $params = $paths;
    array_unshift($params, $shareId);
    $pdo = db();
    $stmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM share_assets WHERE share_id = ? AND asset_path IN (' . $placeholders . ')');
    $stmt->execute($params);
    return (int)$stmt->fetchColumn();
}

function delete_comment_assets(int $shareId, array $paths): int {
    if (empty($paths)) {
        return 0;
    }
    $placeholders = implode(',', array_fill(0, count($paths), '?'));
    $params = $paths;
    array_unshift($params, $shareId);
    $pdo = db();
    $stmt = $pdo->prepare('SELECT asset_path, file_path, size_bytes FROM share_assets WHERE share_id = ? AND asset_path IN (' . $placeholders . ')');
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    if (empty($rows)) {
        return 0;
    }
    global $config;
    $total = 0;
    foreach ($rows as $row) {
        $filePath = (string)($row['file_path'] ?? '');
        $size = (int)($row['size_bytes'] ?? 0);
        if ($filePath !== '') {
            $fullPath = $config['uploads_dir'] . '/' . ltrim($filePath, '/');
            if (is_file($fullPath)) {
                @unlink($fullPath);
            }
        }
        $total += $size;
    }
    $del = $pdo->prepare('DELETE FROM share_assets WHERE share_id = ? AND asset_path IN (' . $placeholders . ')');
    $del->execute($params);
    return $total;
}

function adjust_share_size(int $shareId, int $delta): void {
    if ($delta === 0) {
        return;
    }
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE shares SET size_bytes = CASE
        WHEN size_bytes + :delta < 0 THEN 0
        ELSE size_bytes + :delta
    END WHERE id = :id');
    $stmt->execute([
        ':delta' => $delta,
        ':id' => $shareId,
    ]);
}

function render_share_stats(array $share, string $extraHtml = ''): string {
    $count = (int)($share['access_count'] ?? 0);
    $created = format_share_datetime((string)($share['created_at'] ?? ''));
    $expiresAt = (int)($share['expires_at'] ?? 0);
    $visitorLimit = (int)($share['visitor_limit'] ?? 0);
    $chips = [];
    $chips[] = ['label' => '访问次数', 'value' => $count . ' 次'];
    if ($created !== '') {
        $chips[] = ['label' => '创建时间', 'value' => $created];
    }
    if ($expiresAt > 0) {
        $chips[] = ['label' => '到期时间', 'value' => date('Y-m-d H:i', $expiresAt)];
    }
    if ($visitorLimit > 0) {
        $chips[] = ['label' => '访客上限', 'value' => $visitorLimit . ' 人'];
    }
    if (empty($chips) && $extraHtml === '') {
        return '';
    }
    $html = '<div class="kb-meta">';
    foreach ($chips as $chip) {
        $label = htmlspecialchars($chip['label']);
        $value = htmlspecialchars($chip['value']);
        $html .= "<span class=\"kb-chip\"><strong>{$label}</strong> {$value}</span>";
    }
    if ($extraHtml !== '') {
        $html .= $extraHtml;
    }
    $html .= '</div>';
    return $html;
}

function format_bytes(float $bytes): string {
    if ($bytes <= 0) {
        return '0 B';
    }
    $units = ['B', 'KB', 'MB', 'GB', 'TB'];
    $idx = 0;
    $val = (float)$bytes;
    while ($val >= 1024 && $idx < count($units) - 1) {
        $val /= 1024;
        $idx++;
    }
    return sprintf('%.2f %s', $val, $units[$idx]);
}

function normalize_page_size($raw, int $default = 10): int {
    $allowed = [10, 50, 200, 1000];
    $size = (int)$raw;
    if (!in_array($size, $allowed, true)) {
        $size = $default;
    }
    return $size;
}

function paginate(int $total, int $page, int $size): array {
    $pages = max(1, (int)ceil($total / max(1, $size)));
    $page = max(1, min($page, $pages));
    $offset = ($page - 1) * $size;
    return [$page, $size, $pages, $offset];
}

function build_query_url(array $overrides = []): string {
    $query = array_merge($_GET, $overrides);
    foreach ($query as $key => $value) {
        if ($value === null || $value === '') {
            unset($query[$key]);
        }
    }
    $qs = http_build_query($query);
    return base_path() . '/admin' . ($qs ? '?' . $qs : '');
}

function build_admin_query_url(string $hash, array $overrides = []): string {
    $query = array_merge($_GET, $overrides);
    foreach ($query as $key => $value) {
        if ($value === null || $value === '') {
            unset($query[$key]);
        }
    }
    $qs = http_build_query($query);
    $hashPart = $hash !== '' ? '#' . $hash : '';
    return base_path() . '/admin' . ($qs ? '?' . $qs : '') . $hashPart;
}

function build_dashboard_query_url(array $overrides = []): string {
    $query = array_merge($_GET, $overrides);
    foreach ($query as $key => $value) {
        if ($value === null || $value === '') {
            unset($query[$key]);
        }
    }
    $qs = http_build_query($query);
    return base_path() . '/dashboard' . ($qs ? '?' . $qs : '') . '#shares';
}

function build_access_stats_query_url(array $overrides = []): string {
    $query = array_merge($_GET, $overrides);
    foreach ($query as $key => $value) {
        if ($value === null || $value === '') {
            unset($query[$key]);
        }
    }
    $qs = http_build_query($query);
    return base_path() . '/dashboard' . ($qs ? '?' . $qs : '') . '#access-stats';
}

function render_hidden_inputs(array $values): string {
    $html = '';
    foreach ($values as $key => $value) {
        if ($value === null || $value === '') {
            continue;
        }
        $html .= '<input type="hidden" name="' . htmlspecialchars((string)$key) . '" value="' . htmlspecialchars((string)$value) . '">';
    }
    return $html;
}

function bytes_from_mb(int $mb): int {
    if ($mb <= 0) {
        return 0;
    }
    return $mb * 1024 * 1024;
}

function mb_from_bytes(int $bytes): int {
    if ($bytes <= 0) {
        return 0;
    }
    return (int)floor($bytes / 1024 / 1024);
}

function render_share_icon_defs(): string {
    return <<<'SVG'
<svg class="kb-icon-defs" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
  <symbol id="sps-tree-arrow-collapsed" viewBox="0 0 24 24" fill="none">
    <path d="M9 18L15 12L9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </symbol>
  <symbol id="sps-tree-arrow-expanded" viewBox="0 0 24 24" fill="none">
    <path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </symbol>
  <symbol id="sps-tree-collapse-all" viewBox="0 0 24 24" fill="none">
    <path d="M4 20L11 13M11 13V17M11 13H7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M20 4L13 11M13 11V7M13 11H17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </symbol>
  <symbol id="sps-tree-expand-all" viewBox="0 0 24 24" fill="none">
    <path d="M11 13L4 20M4 20V16M4 20H8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M13 11L20 4M20 4V8M20 4H16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </symbol>
</svg>
SVG;
}

function render_page(string $title, string $content, ?array $user = null, string $baseHref = '', array $options = []): void {
    global $config;
    $base = base_path();
    $app = htmlspecialchars($config['app_name']);
    $pageTitle = htmlspecialchars($title);
    $userName = $user ? htmlspecialchars($user['username']) : '';
    $layout = isset($options['layout']) ? (string)$options['layout'] : ($user ? 'app' : 'public');
    $titleHtml = $pageTitle;
    if (!empty($options['title_html'])) {
        $titleHtml = (string)$options['title_html'];
    }
    $layoutClass = 'layout-' . preg_replace('/[^a-z0-9_-]+/i', '', $layout);
    $includeMarkdown = !empty($options['markdown']);
    $navKey = (string)($options['nav'] ?? '');
    if ($user && $layout !== 'auth' && $layout !== 'share') {
        maybe_send_instance_heartbeat();
    }
    echo "<!doctype html>";
    echo "<html lang='zh-CN'>";
    echo "<head>";
    echo "<meta charset='utf-8'>";
    echo "<meta name='viewport' content='width=device-width, initial-scale=1'>";
    echo "<title>{$pageTitle} - {$app}</title>";
    if ($baseHref !== '') {
        $safeBase = htmlspecialchars($baseHref);
        echo "<base href='{$safeBase}'>";
    }
    if ($includeMarkdown) {
        echo "<link rel='stylesheet' href='{$base}/assets/vendor/github-markdown.min.css'>";
        echo "<link rel='stylesheet' href='{$base}/assets/vendor/katex.min.css'>";
        echo "<link rel='stylesheet' href='{$base}/assets/vendor/highlight.min.css'>";
    }
    echo "<link rel='stylesheet' href='{$base}/assets/style.css'>";
    echo "</head>";
    echo "<body class='{$layoutClass}'>";

    if ($layout === 'auth') {
        echo "<div class='auth-shell'>";
        echo $content;
        echo "</div>";
    } elseif ($layout === 'share') {
        echo "<div class='share-page'>";
        echo render_share_icon_defs();
        echo $content;
        echo "<footer class='share-footer'>由 <a href='https://github.com/b8l8u8e8/siyuan-plugin-share' target='_blank' rel='noopener noreferrer'>b8l8u8e8</a> 提供支持</footer>";
        echo "<button class='share-side-trigger' type='button' data-share-drawer-open aria-label='打开侧边栏'><svg viewBox='0 0 24 24' aria-hidden='true'><path fill='currentColor' d='M4 6h16v2H4zM4 11h16v2H4zM4 16h16v2H4z'/></svg><span>导航</span></button>";
        echo "<div class='share-side-backdrop' data-share-drawer-close></div>";
        echo "<button class='scroll-top' type='button' data-scroll-top aria-label='回到顶部'><svg viewBox='0 0 24 24' aria-hidden='true'><path fill='currentColor' d='M12 2c-2.76 0-5 2.24-5 5v2.5L4 13l4.5 1L12 22l3.5-8L20 13l-3-3.5V7c0-2.76-2.24-5-5-5zm0 3a2 2 0 0 1 2 2v1.5l-2 2-2-2V7a2 2 0 0 1 2-2z'/></svg></button>";
        echo "</div>";
    } elseif ($user) {
        $navItems = [
            ['key' => 'dashboard', 'label' => '控制台', 'href' => $base . '/dashboard'],
            ['key' => 'shares', 'label' => '分享记录', 'href' => $base . '/dashboard#shares'],
            ['key' => 'access-stats', 'label' => '访问统计', 'href' => $base . '/dashboard#access-stats'],
            ['key' => 'account', 'label' => '账号设置', 'href' => $base . '/account'],
        ];
        if (($user['role'] ?? '') === 'admin') {
            $reportBadge = pending_report_count();
            $navItems = [
                ['key' => 'dashboard', 'label' => '控制台', 'href' => $base . '/dashboard'],
                ['key' => 'account', 'label' => '账号设置', 'href' => $base . '/account'],
                ['key' => 'admin-home', 'label' => '数据统计', 'href' => $base . '/admin-home'],
                ['key' => 'admin-settings', 'label' => '站点设置', 'href' => $base . '/admin#settings'],
                ['key' => 'admin-announcements', 'label' => '公告管理', 'href' => $base . '/admin#announcements'],
                ['key' => 'admin-reports', 'label' => '举报管理', 'href' => $base . '/admin#reports', 'badge' => $reportBadge],
                ['key' => 'admin-users', 'label' => '用户管理', 'href' => $base . '/admin#users'],
                ['key' => 'admin-shares', 'label' => '分享管理', 'href' => $base . '/admin#shares'],
                ['key' => 'admin-chunks', 'label' => '分片清理', 'href' => $base . '/admin#chunks'],
                ['key' => 'admin-scan', 'label' => '违禁词扫描', 'href' => $base . '/admin#scan'],
            ];
        }
        echo "<div class='app-shell'>";
        echo "<aside class='app-sidebar'>";
        echo "<div class='app-logo'>{$app}</div>";
        echo "<nav class='app-nav'>";
        foreach ($navItems as $item) {
            $active = $navKey === $item['key'] ? ' is-active' : '';
            $label = htmlspecialchars($item['label']);
            $badge = (int)($item['badge'] ?? 0);
            $hrefRaw = (string)$item['href'];
            $hashPos = strpos($hrefRaw, '#');
            $pathOnly = $hashPos === false ? $hrefRaw : substr($hrefRaw, 0, $hashPos);
            $hash = $hashPos === false ? '' : substr($hrefRaw, $hashPos + 1);
            $href = htmlspecialchars($hrefRaw);
            $dataAttrs = ' data-nav-key="' . htmlspecialchars((string)$item['key']) . '"';
            $dataAttrs .= ' data-nav-path="' . htmlspecialchars($pathOnly) . '"';
            if ($hash !== '') {
                $dataAttrs .= ' data-nav-hash="' . htmlspecialchars($hash) . '"';
            }
            echo "<a class='nav-item{$active}' href='{$href}'{$dataAttrs}><span class='nav-dot'></span><span class='nav-label'>{$label}</span>";
            if ($badge > 0) {
                echo "<span class='nav-badge'>{$badge}</span>";
            }
            echo "</a>";
        }
        echo "</nav>";
        echo "</aside>";
        echo "<div class='app-main'>";
        echo "<header class='app-topbar'>";
        echo "<div class='topbar-left'>";
        echo "<button class='app-side-trigger' type='button' data-app-drawer-open aria-label='打开导航'><svg viewBox='0 0 24 24' aria-hidden='true'><path fill='currentColor' d='M4 6h16v2H4zM4 11h16v2H4zM4 16h16v2H4z'/></svg></button>";
        echo "<div class='topbar-title'>{$titleHtml}</div>";
        echo "</div>";
        echo "<div class='topbar-right'>";
        echo "<span class='user-pill'>{$userName}</span>";
        echo "<form method='post' action='{$base}/logout' class='inline-form'>";
        echo "<input type='hidden' name='csrf' value='" . csrf_token() . "'>";
        echo "<button class='button ghost' type='submit'>退出</button>";
        echo "</form>";
        echo "</div>";
        echo "</header>";
        echo "<main class='app-content'>";
        echo $content;
        echo "</main>";
        echo "<footer class='app-footer'>由 <a href='https://github.com/b8l8u8e8/siyuan-plugin-share' target='_blank' rel='noopener noreferrer'>b8l8u8e8</a> 提供支持</footer>";
        echo "</div>";
        echo "</div>";
        echo "<div class='app-side-backdrop' data-app-drawer-close></div>";
    } else {
        echo "<div class='public-shell'>";
        echo $content;
        echo "</div>";
    }

    if ($user && $layout === 'app') {
        $announcements = get_active_announcements();
        if (should_show_announcement_modal($announcements)) {
            echo render_announcement_modal($announcements);
        }
    }

    echo "<script defer src='{$base}/assets/app.js'></script>";
    if ($includeMarkdown) {
        echo "<script defer src='{$base}/assets/vendor/markdown-it.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/markdown-it-task-lists.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/markdown-it-emoji.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/markdown-it-footnote.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/markdown-it-deflist.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/markdown-it-mark.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/markdown-it-sub.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/markdown-it-sup.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/markdown-it-abbr.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/markdown-it-ins.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/markdown-it-container.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/markdown-it-anchor.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/katex.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/highlight.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/mermaid.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/pako.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/echarts.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/abcjs-basic-min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/raphael.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/flowchart.min.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/viz.js'></script>";
        echo "<script defer src='{$base}/assets/vendor/full.render.js' onload=\"window.dispatchEvent(new Event('sps:markdown-ready'))\"></script>";
    }
    echo "</body>";
    echo "</html>";
    exit;
}

function generate_captcha_code(int $length = 5): string {
    $alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    $max = strlen($alphabet) - 1;
    $code = '';
    for ($i = 0; $i < $length; $i++) {
        $code .= $alphabet[random_int(0, $max)];
    }
    $_SESSION['captcha_code'] = $code;
    $_SESSION['captcha_at'] = time();
    return $code;
}

function captcha_url(): string {
    $base = base_path();
    return $base . '/captcha?ts=' . time();
}

function check_captcha(string $input): bool {
    if (!captcha_enabled()) {
        return true;
    }
    $expected = $_SESSION['captcha_code'] ?? '';
    $input = strtoupper(trim($input));
    $ok = $expected !== '' && $input === strtoupper($expected);
    if (!$ok) {
        generate_captcha_code();
    }
    return $ok;
}

function render_captcha_image(): void {
    if (!captcha_enabled()) {
        http_response_code(404);
        exit;
    }
    if (!function_exists('imagecreatetruecolor')) {
        http_response_code(500);
        echo 'GD extension required.';
        exit;
    }
    $code = generate_captcha_code();
    $width = 120;
    $height = 40;
    $scale = 1.2;
    $outWidth = (int)round($width * $scale);
    $outHeight = (int)round($height * $scale);
    $image = imagecreatetruecolor($width, $height);
    if (!$image) {
        http_response_code(500);
        exit;
    }
    $bg = imagecolorallocate($image, 245, 248, 255);
    $fg = imagecolorallocate($image, 50, 88, 160);
    $noise = imagecolorallocate($image, 200, 210, 230);
    imagefilledrectangle($image, 0, 0, $width, $height, $bg);
    for ($i = 0; $i < 6; $i++) {
        imageline($image, random_int(0, $width), random_int(0, $height), random_int(0, $width), random_int(0, $height), $noise);
    }
    for ($i = 0; $i < 60; $i++) {
        imagesetpixel($image, random_int(0, $width), random_int(0, $height), $noise);
    }
    $x = 10;
    $y = 10;
    $chars = str_split($code);
    foreach ($chars as $char) {
        imagestring($image, 5, $x, $y + random_int(-3, 3), $char, $fg);
        $x += 18;
    }
    header('Content-Type: image/png');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    $output = $image;
    if ($outWidth !== $width || $outHeight !== $height) {
        $scaled = imagecreatetruecolor($outWidth, $outHeight);
        imagecopyresampled($scaled, $image, 0, 0, 0, 0, $outWidth, $outHeight, $width, $height);
        imagedestroy($image);
        $output = $scaled;
    }
    imagepng($output);
    imagedestroy($output);
    exit;
}

function sanitize_slug(string $slug): string {
    $slug = strtolower(trim($slug));
    $slug = preg_replace('/[^a-z0-9_-]+/', '-', $slug);
    $slug = preg_replace('/-+/', '-', $slug);
    $slug = trim($slug, '-.');
    return substr($slug, 0, 64);
}

function generate_api_key(): array {
    $raw = bin2hex(random_bytes(24));
    $hash = password_hash($raw, PASSWORD_DEFAULT);
    $prefix = substr($raw, 0, 8);
    $last4 = substr($raw, -4);
    return [$raw, $hash, $prefix, $last4];
}

function get_user_limit_bytes(array $user): int {
    $userLimit = isset($user['storage_limit_bytes']) ? (int)$user['storage_limit_bytes'] : 0;
    if ($userLimit > 0) {
        return $userLimit;
    }
    return default_storage_limit_bytes();
}

function recalculate_user_storage(int $userId): int {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM shares WHERE user_id = :uid AND deleted_at IS NULL');
    $stmt->execute([':uid' => $userId]);
    $shareTotal = (int)($stmt->fetch(PDO::FETCH_ASSOC)['total'] ?? 0);
    $logStmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM share_access_logs WHERE user_id = :uid');
    $logStmt->execute([':uid' => $userId]);
    $logTotal = (int)($logStmt->fetch(PDO::FETCH_ASSOC)['total'] ?? 0);
    $total = $shareTotal + $logTotal;
    $update = $pdo->prepare('UPDATE users SET storage_used_bytes = :total WHERE id = :id');
    $update->execute([':total' => $total, ':id' => $userId]);
    return $total;
}

function adjust_user_storage(int $userId, int $delta): void {
    if ($delta === 0) {
        return;
    }
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE users SET storage_used_bytes = CASE
        WHEN storage_used_bytes + :delta < 0 THEN 0
        ELSE storage_used_bytes + :delta
    END WHERE id = :id');
    $stmt->execute([
        ':delta' => $delta,
        ':id' => $userId,
    ]);
}

function get_user_by_id(int $userId): ?array {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM users WHERE id = :id');
    $stmt->execute([':id' => $userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function get_client_ip(): string {
    $candidates = [
        'HTTP_CF_CONNECTING_IP',
        'HTTP_X_REAL_IP',
        'HTTP_X_FORWARDED_FOR',
        'REMOTE_ADDR',
    ];
    foreach ($candidates as $key) {
        $value = trim((string)($_SERVER[$key] ?? ''));
        if ($value === '') {
            continue;
        }
        if ($key === 'HTTP_X_FORWARDED_FOR') {
            $parts = array_values(array_filter(array_map('trim', explode(',', $value))));
            $value = $parts[0] ?? '';
        }
        if ($value !== '') {
            return $value;
        }
    }
    return '';
}

function get_visitor_id(): string {
    $existing = trim((string)($_COOKIE['sps_uv'] ?? ''));
    if ($existing !== '') {
        return $existing;
    }
    $id = bin2hex(random_bytes(12));
    setcookie('sps_uv', $id, time() + 86400 * 365, '/', '', false, true);
    $_COOKIE['sps_uv'] = $id;
    return $id;
}

function http_get_json(string $url): ?array {
    $context = stream_context_create([
        'http' => [
            'timeout' => 2,
            'header' => "User-Agent: SiyuanShareAccessStats\r\n",
        ],
    ]);
    $raw = @file_get_contents($url, false, $context);
    if ($raw === false || $raw === '') {
        return null;
    }
    $json = json_decode($raw, true);
    if (is_array($json)) {
        return $json;
    }
    $converted = null;
    if (function_exists('mb_convert_encoding')) {
        $converted = @mb_convert_encoding($raw, 'UTF-8', 'UTF-8,GBK,GB2312,GB18030');
    }
    if ($converted === null && function_exists('iconv')) {
        $converted = @iconv('GBK', 'UTF-8//IGNORE', $raw);
        if ($converted === false || $converted === '') {
            $converted = @iconv('GB18030', 'UTF-8//IGNORE', $raw);
        }
    }
    if ($converted) {
        $json = json_decode($converted, true);
        if (is_array($json)) {
            return $json;
        }
    }
    return null;
}

function http_post_json(string $url, array $payload): ?array {
    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'timeout' => 2,
            'header' => "User-Agent: SiyuanShareAccessStats\r\nContent-Type: application/json\r\n",
            'content' => json_encode($payload, JSON_UNESCAPED_UNICODE),
        ],
    ]);
    $raw = @file_get_contents($url, false, $context);
    if ($raw === false || $raw === '') {
        return null;
    }
    $json = json_decode($raw, true);
    if (is_array($json)) {
        return $json;
    }
    $converted = null;
    if (function_exists('mb_convert_encoding')) {
        $converted = @mb_convert_encoding($raw, 'UTF-8', 'UTF-8,GBK,GB2312,GB18030');
    }
    if ($converted === null && function_exists('iconv')) {
        $converted = @iconv('GBK', 'UTF-8//IGNORE', $raw);
        if ($converted === false || $converted === '') {
            $converted = @iconv('GB18030', 'UTF-8//IGNORE', $raw);
        }
    }
    if ($converted) {
        $json = json_decode($converted, true);
        if (is_array($json)) {
            return $json;
        }
    }
    return null;
}

function min_chunk_size_bytes(): int {
    global $config;
    $kb = (int)($config['min_chunk_size_kb'] ?? 256);
    if ($kb <= 0) {
        $kb = 256;
    }
    return $kb * 1024;
}

function max_chunk_size_bytes(): int {
    global $config;
    $mb = (int)($config['max_chunk_size_mb'] ?? 8);
    if ($mb <= 0) {
        $mb = 8;
    }
    return $mb * 1024 * 1024;
}

function chunk_size_limits(): array {
    $min = min_chunk_size_bytes();
    $max = max_chunk_size_bytes();
    if ($max < $min) {
        $max = $min;
    }
    return [$min, $max];
}

function site_version(): string {
    global $config;
    return trim((string)($config['site_version'] ?? ''));
}

function central_stats_url(): string {
    global $config;
    $raw = trim((string)($config['central_stats_url'] ?? ''));
    return rtrim($raw, '/');
}

function get_instance_id(): string {
    try {
        $existing = trim((string)get_setting('instance_id', ''));
        if ($existing !== '') {
            return $existing;
        }
        $generated = bin2hex(random_bytes(16));
        set_setting('instance_id', $generated);
        return $generated;
    } catch (Throwable $e) {
        return bin2hex(random_bytes(16));
    }
}

function maybe_send_instance_heartbeat(): void {
    $base = central_stats_url();
    if ($base === '') {
        return;
    }
    $interval = 10800;
    $lastAttempt = (int)get_setting('instance_heartbeat_attempt', '0');
    if ($lastAttempt > 0 && (time() - $lastAttempt) < $interval) {
        return;
    }
    set_setting('instance_heartbeat_attempt', (string)time());
    $payload = [
        'instance_id' => get_instance_id(),
        'version' => site_version(),
        'timestamp' => time(),
    ];
    $resp = http_post_json($base . '/api/instances/heartbeat', $payload);
    if (is_array($resp) && (int)($resp['code'] ?? 1) === 0) {
        set_setting('instance_heartbeat_at', (string)time());
    }
}

function fetch_latest_release_info(): ?array {
    $cachePath = __DIR__ . '/storage/release_cache.json';
    $ttl = 3600;
    if (is_file($cachePath) && (time() - filemtime($cachePath) < $ttl)) {
        $cached = json_decode((string)file_get_contents($cachePath), true);
        if (is_array($cached)) {
            return $cached;
        }
    }
    $latest = [
        'version' => '',
        'url' => '',
        'has_php_site' => false,
        'fetched_at' => time(),
    ];
    $perPage = 30;
    $page = 1;
    while (true) {
        $url = 'https://api.github.com/repos/b8l8u8e8/siyuan-plugin-share/releases?per_page=' . $perPage . '&page=' . $page;
        $data = http_get_json($url);
        if (!$data || !is_array($data)) {
            if ($page === 1) {
                return null;
            }
            break;
        }
        if (empty($data)) {
            break;
        }
        $keys = array_keys($data);
        if ($keys !== range(0, count($keys) - 1)) {
            if ($page === 1) {
                return null;
            }
            break;
        }
        foreach ($data as $release) {
            if (!is_array($release)) {
                continue;
            }
            $assets = is_array($release['assets'] ?? null) ? $release['assets'] : [];
            $version = '';
            $hasPhpSite = false;
            foreach ($assets as $asset) {
                $name = (string)($asset['name'] ?? '');
                if ($name === '') {
                    continue;
                }
                if (stripos($name, 'php-site') === false) {
                    continue;
                }
                $hasPhpSite = true;
                if (preg_match('/php-site-v(.+)\.zip/i', $name, $matches)) {
                    $version = trim((string)($matches[1] ?? ''));
                }
                break;
            }
            if ($hasPhpSite) {
                if ($version === '') {
                    $version = trim((string)($release['tag_name'] ?? $release['name'] ?? ''));
                }
                $latest['version'] = $version;
                $latest['url'] = (string)($release['html_url'] ?? '');
                $latest['has_php_site'] = true;
                $latest['fetched_at'] = time();
                break 2;
            }
        }
        if (count($data) < $perPage) {
            break;
        }
        $page++;
    }
    try {
        ensure_dir(dirname($cachePath));
        file_put_contents($cachePath, json_encode($latest, JSON_UNESCAPED_SLASHES));
    } catch (Throwable $e) {
        // ignore cache failure
    }
    return $latest;
}

function site_update_info(): ?array {
    $current = site_version();
    maybe_send_instance_heartbeat();
    $latest = fetch_latest_release_info();
    if (!$latest || empty($latest['has_php_site']) || ($latest['version'] ?? '') === '') {
        return null;
    }
    $latestVersion = trim((string)$latest['version']);
    $currentVersion = trim((string)$current);
    $latestComparable = ltrim($latestVersion, 'vV');
    $currentComparable = ltrim($currentVersion, 'vV');
    $isNewer = false;
    if ($currentComparable === '') {
        $isNewer = true;
    } else {
        $isNewer = version_compare($latestComparable, $currentComparable, '>');
    }
    if (!$isNewer) {
        return null;
    }
    return [
        'version' => $latestVersion,
        'url' => (string)($latest['url'] ?? ''),
    ];
}

function fetch_central_instance_stats(): ?array {
    $base = central_stats_url();
    if ($base === '') {
        return null;
    }
    $cached = null;
    $cachedRaw = (string)get_setting('central_stats_cache', '');
    if ($cachedRaw !== '') {
        $cached = json_decode($cachedRaw, true);
        if (!is_array($cached)) {
            $cached = null;
        }
    }
    $resp = http_get_json($base . '/api/instances/stats');
    if (!is_array($resp) || (int)($resp['code'] ?? 1) !== 0) {
        return $cached;
    }
    $data = $resp['data'] ?? null;
    if (!is_array($data)) {
        return $cached;
    }
    $data['fetched_at'] = now();
    set_setting('central_stats_cache', json_encode($data, JSON_UNESCAPED_UNICODE));
    return $data;
}

function build_date_range(int $days): array {
    $days = max(1, $days);
    $dates = [];
    for ($i = $days - 1; $i >= 0; $i--) {
        $dates[] = date('Y-m-d', strtotime("-{$i} days"));
    }
    return $dates;
}

function fill_series(array $dates, array $rows, string $field): array {
    $map = [];
    foreach ($rows as $row) {
        $day = (string)($row['day'] ?? '');
        if ($day === '') {
            continue;
        }
        $map[$day] = (float)($row[$field] ?? 0);
    }
    $series = [];
    foreach ($dates as $day) {
        $series[] = (float)($map[$day] ?? 0);
    }
    return $series;
}

function build_chart_paths(array $values, int $width, int $height, int $padding, float $maxValue): array {
    $count = count($values);
    if ($count === 0) {
        return ['line' => '', 'area' => ''];
    }
    $step = $count > 1 ? ($width - $padding * 2) / ($count - 1) : 0;
    $points = [];
    for ($i = 0; $i < $count; $i++) {
        $val = (float)$values[$i];
        $ratio = $maxValue > 0 ? ($val / $maxValue) : 0;
        $x = $padding + ($step * $i);
        $y = $height - $padding - ($ratio * ($height - $padding * 2));
        $points[] = [$x, $y];
    }
    $line = 'M ' . implode(' L ', array_map(fn($pt) => round($pt[0], 2) . ' ' . round($pt[1], 2), $points));
    $areaPoints = $points;
    $areaPoints[] = [$padding + ($step * ($count - 1)), $height - $padding];
    $areaPoints[] = [$padding, $height - $padding];
    $area = 'M ' . implode(' L ', array_map(fn($pt) => round($pt[0], 2) . ' ' . round($pt[1], 2), $areaPoints)) . ' Z';
    return ['line' => $line, 'area' => $area];
}

function render_chart_svg(array $seriesList, int $width = 360, int $height = 220): string {
    $maxValue = 0;
    foreach ($seriesList as $series) {
        foreach ($series['values'] as $value) {
            $maxValue = max($maxValue, (float)$value);
        }
    }
    if ($maxValue <= 0) {
        $maxValue = 1;
    }
    $padding = 12;
    $gridLines = [];
    foreach ([0.33, 0.66] as $ratio) {
        $y = $height - $padding - ($ratio * ($height - $padding * 2));
        $gridLines[] = '<line x1="' . $padding . '" y1="' . round($y, 2) . '" x2="' . ($width - $padding) . '" y2="' . round($y, 2) . '"></line>';
    }
    $paths = '';
    foreach ($seriesList as $series) {
        $pathsData = build_chart_paths($series['values'], $width, $height, $padding, $maxValue);
        $areaClass = $series['area_class'] ?? '';
        if ($areaClass !== '') {
            $paths .= '<path class="' . $areaClass . '" d="' . $pathsData['area'] . '"></path>';
        }
    }
    foreach ($seriesList as $series) {
        $lineClass = $series['line_class'] ?? '';
        $pathsData = build_chart_paths($series['values'], $width, $height, $padding, $maxValue);
        $paths .= '<path class="' . $lineClass . '" d="' . $pathsData['line'] . '"></path>';
    }
    return '<svg class="admin-chart" viewBox="0 0 ' . $width . ' ' . $height . '" preserveAspectRatio="none">'
        . '<g class="admin-chart__grid">' . implode('', $gridLines) . '</g>'
        . $paths
        . '</svg>';
}

function render_admin_chart_holder(array $labels, array $series, string $unit, string $fallbackSvg = ''): string {
    $payload = [
        'labels' => $labels,
        'series' => $series,
        'unit' => $unit,
    ];
    $data = htmlspecialchars(
        json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ENT_QUOTES
    );
    return '<div class="admin-chart-holder" data-admin-chart="' . $data . '">' . $fallbackSvg . '</div>';
}

function render_kpi_card(string $label, string $value, string $meta, string $iconSvg, string $extraHtml = ''): string {
    return '<div class="admin-kpi">'
        . '<div class="admin-kpi__head"><div><div class="admin-kpi__label">' . $label . '</div>'
        . '<div class="admin-kpi__value">' . $value . '</div></div>'
        . '<div class="admin-kpi__icon">' . $iconSvg . '</div></div>'
        . '<div class="admin-kpi__meta">' . $meta . '</div>'
        . $extraHtml
        . '</div>';
}

function build_topbar_title(string $title, ?array $user): string {
    $titleHtml = htmlspecialchars($title);
    $versionText = site_version();
    if ($versionText !== '') {
        $versionLabel = $versionText;
        if (stripos($versionLabel, 'v') !== 0) {
            $versionLabel = 'v' . $versionLabel;
        }
        $titleHtml .= ' <span class="topbar-version">' . htmlspecialchars($versionLabel) . '</span>';
    }
    if ($user && ($user['role'] ?? '') === 'admin') {
        $update = site_update_info();
        if ($update) {
            $updateVersion = trim((string)($update['version'] ?? ''));
            if ($updateVersion !== '' && stripos($updateVersion, 'v') !== 0) {
                $updateVersion = 'v' . $updateVersion;
            }
            $updateLabel = htmlspecialchars('有新版 ' . $updateVersion);
            $updateUrl = trim((string)($update['url'] ?? ''));
            if ($updateUrl !== '') {
                $titleHtml .= ' <a class="topbar-version is-update" href="' . htmlspecialchars($updateUrl) . '" target="_blank" rel="noopener noreferrer">' . $updateLabel . '</a>';
            } else {
                $titleHtml .= ' <span class="topbar-version is-update">' . $updateLabel . '</span>';
            }
        }
    }
    return $titleHtml;
}

function country_code_zh_map(): array {
    static $map = null;
    if ($map !== null) {
        return $map;
    }
    $map = [
        'AF' => '阿富汗',
        'AL' => '阿尔巴尼亚',
        'DZ' => '阿尔及利亚',
        'AS' => '美属萨摩亚',
        'AD' => '安道尔',
        'AO' => '安哥拉',
        'AI' => '安圭拉',
        'AQ' => '南极洲',
        'AG' => '安提瓜和巴布达',
        'AR' => '阿根廷',
        'AM' => '亚美尼亚',
        'AW' => '阿鲁巴',
        'AU' => '澳大利亚',
        'AT' => '奥地利',
        'AZ' => '阿塞拜疆',
        'BS' => '巴哈马',
        'BH' => '巴林',
        'BD' => '孟加拉国',
        'BB' => '巴巴多斯',
        'BY' => '白俄罗斯',
        'BE' => '比利时',
        'BZ' => '伯利兹',
        'BJ' => '贝宁',
        'BM' => '百慕大',
        'BT' => '不丹',
        'BO' => '玻利维亚',
        'BA' => '波斯尼亚和黑塞哥维那',
        'BW' => '博茨瓦纳',
        'BR' => '巴西',
        'IO' => '英属印度洋领地',
        'BN' => '文莱',
        'BG' => '保加利亚',
        'BF' => '布基纳法索',
        'BI' => '布隆迪',
        'KH' => '柬埔寨',
        'CM' => '喀麦隆',
        'CA' => '加拿大',
        'CV' => '佛得角',
        'KY' => '开曼群岛',
        'CF' => '中非共和国',
        'TD' => '乍得',
        'CL' => '智利',
        'CN' => '中国',
        'CX' => '圣诞岛',
        'CC' => '科科斯（基林）群岛',
        'CO' => '哥伦比亚',
        'KM' => '科摩罗',
        'CG' => '刚果（布）',
        'CD' => '刚果（金）',
        'CK' => '库克群岛',
        'CR' => '哥斯达黎加',
        'CI' => '科特迪瓦',
        'HR' => '克罗地亚',
        'CU' => '古巴',
        'CY' => '塞浦路斯',
        'CZ' => '捷克',
        'DK' => '丹麦',
        'DJ' => '吉布提',
        'DM' => '多米尼克',
        'DO' => '多米尼加共和国',
        'EC' => '厄瓜多尔',
        'EG' => '埃及',
        'SV' => '萨尔瓦多',
        'GQ' => '赤道几内亚',
        'ER' => '厄立特里亚',
        'EE' => '爱沙尼亚',
        'SZ' => '斯威士兰',
        'ET' => '埃塞俄比亚',
        'FK' => '福克兰群岛',
        'FO' => '法罗群岛',
        'FJ' => '斐济',
        'FI' => '芬兰',
        'FR' => '法国',
        'GF' => '法属圭亚那',
        'PF' => '法属波利尼西亚',
        'TF' => '法属南部领地',
        'GA' => '加蓬',
        'GM' => '冈比亚',
        'GE' => '格鲁吉亚',
        'DE' => '德国',
        'GH' => '加纳',
        'GI' => '直布罗陀',
        'GR' => '希腊',
        'GL' => '格陵兰',
        'GD' => '格林纳达',
        'GP' => '瓜德罗普',
        'GU' => '关岛',
        'GT' => '危地马拉',
        'GG' => '根西',
        'GN' => '几内亚',
        'GW' => '几内亚比绍',
        'GY' => '圭亚那',
        'HT' => '海地',
        'HM' => '赫德岛和麦克唐纳群岛',
        'HN' => '洪都拉斯',
        'HK' => '中国香港',
        'HU' => '匈牙利',
        'IS' => '冰岛',
        'IN' => '印度',
        'ID' => '印度尼西亚',
        'IR' => '伊朗',
        'IQ' => '伊拉克',
        'IE' => '爱尔兰',
        'IM' => '马恩岛',
        'IL' => '以色列',
        'IT' => '意大利',
        'JM' => '牙买加',
        'JP' => '日本',
        'JE' => '泽西',
        'JO' => '约旦',
        'KZ' => '哈萨克斯坦',
        'KE' => '肯尼亚',
        'KI' => '基里巴斯',
        'KP' => '朝鲜',
        'KR' => '韩国',
        'KW' => '科威特',
        'KG' => '吉尔吉斯斯坦',
        'LA' => '老挝',
        'LV' => '拉脱维亚',
        'LB' => '黎巴嫩',
        'LS' => '莱索托',
        'LR' => '利比里亚',
        'LY' => '利比亚',
        'LI' => '列支敦士登',
        'LT' => '立陶宛',
        'LU' => '卢森堡',
        'MO' => '中国澳门',
        'MK' => '北马其顿',
        'MG' => '马达加斯加',
        'MW' => '马拉维',
        'MY' => '马来西亚',
        'MV' => '马尔代夫',
        'ML' => '马里',
        'MT' => '马耳他',
        'MH' => '马绍尔群岛',
        'MQ' => '马提尼克',
        'MR' => '毛里塔尼亚',
        'MU' => '毛里求斯',
        'YT' => '马约特',
        'MX' => '墨西哥',
        'FM' => '密克罗尼西亚',
        'MD' => '摩尔多瓦',
        'MC' => '摩纳哥',
        'MN' => '蒙古',
        'ME' => '黑山',
        'MS' => '蒙特塞拉特',
        'MA' => '摩洛哥',
        'MZ' => '莫桑比克',
        'MM' => '缅甸',
        'NA' => '纳米比亚',
        'NR' => '瑙鲁',
        'NP' => '尼泊尔',
        'NL' => '荷兰',
        'NC' => '新喀里多尼亚',
        'NZ' => '新西兰',
        'NI' => '尼加拉瓜',
        'NE' => '尼日尔',
        'NG' => '尼日利亚',
        'NU' => '纽埃',
        'NF' => '诺福克岛',
        'MP' => '北马里亚纳群岛',
        'NO' => '挪威',
        'OM' => '阿曼',
        'PK' => '巴基斯坦',
        'PW' => '帕劳',
        'PS' => '巴勒斯坦',
        'PA' => '巴拿马',
        'PG' => '巴布亚新几内亚',
        'PY' => '巴拉圭',
        'PE' => '秘鲁',
        'PH' => '菲律宾',
        'PN' => '皮特凯恩群岛',
        'PL' => '波兰',
        'PT' => '葡萄牙',
        'PR' => '波多黎各',
        'QA' => '卡塔尔',
        'RE' => '留尼汪',
        'RO' => '罗马尼亚',
        'RU' => '俄罗斯',
        'RW' => '卢旺达',
        'BL' => '圣巴泰勒米',
        'SH' => '圣赫勒拿',
        'KN' => '圣基茨和尼维斯',
        'LC' => '圣卢西亚',
        'MF' => '法属圣马丁',
        'PM' => '圣皮埃尔和密克隆',
        'VC' => '圣文森特和格林纳丁斯',
        'WS' => '萨摩亚',
        'SM' => '圣马力诺',
        'ST' => '圣多美和普林西比',
        'SA' => '沙特阿拉伯',
        'SN' => '塞内加尔',
        'RS' => '塞尔维亚',
        'SC' => '塞舌尔',
        'SL' => '塞拉利昂',
        'SG' => '新加坡',
        'SX' => '荷属圣马丁',
        'SK' => '斯洛伐克',
        'SI' => '斯洛文尼亚',
        'SB' => '所罗门群岛',
        'SO' => '索马里',
        'ZA' => '南非',
        'GS' => '南乔治亚和南桑威奇群岛',
        'SS' => '南苏丹',
        'ES' => '西班牙',
        'LK' => '斯里兰卡',
        'SD' => '苏丹',
        'SR' => '苏里南',
        'SJ' => '斯瓦尔巴和扬马延',
        'SE' => '瑞典',
        'CH' => '瑞士',
        'SY' => '叙利亚',
        'TW' => '中国台湾',
        'TJ' => '塔吉克斯坦',
        'TZ' => '坦桑尼亚',
        'TH' => '泰国',
        'TL' => '东帝汶',
        'TG' => '多哥',
        'TK' => '托克劳',
        'TO' => '汤加',
        'TT' => '特立尼达和多巴哥',
        'TN' => '突尼斯',
        'TR' => '土耳其',
        'TM' => '土库曼斯坦',
        'TC' => '特克斯和凯科斯群岛',
        'TV' => '图瓦卢',
        'UG' => '乌干达',
        'UA' => '乌克兰',
        'AE' => '阿联酋',
        'GB' => '英国',
        'US' => '美国',
        'UM' => '美国本土外小岛屿',
        'UY' => '乌拉圭',
        'UZ' => '乌兹别克斯坦',
        'VU' => '瓦努阿图',
        'VA' => '梵蒂冈',
        'VE' => '委内瑞拉',
        'VN' => '越南',
        'VG' => '英属维尔京群岛',
        'VI' => '美属维尔京群岛',
        'WF' => '瓦利斯和富图纳',
        'EH' => '西撒哈拉',
        'YE' => '也门',
        'ZM' => '赞比亚',
        'ZW' => '津巴布韦',
        'AX' => '奥兰群岛',
        'BQ' => '荷兰加勒比区',
        'CW' => '库拉索',
        'XK' => '科索沃',
    ];
    return $map;
}

function has_non_ascii(string $value): bool {
    return (bool)preg_match('/[\x80-\xFF]/', $value);
}

function normalize_country_name(string $country, string $countryCode): string {
    $code = strtoupper(trim($countryCode));
    if ($code !== '') {
        $map = country_code_zh_map();
        if (isset($map[$code])) {
            return $map[$code];
        }
    }
    return $country;
}

function normalize_us_region(string $region): string {
    $raw = trim($region);
    if ($raw === '') {
        return '';
    }
    $abbrMap = [
        'AL' => '阿拉巴马州',
        'AK' => '阿拉斯加州',
        'AZ' => '亚利桑那州',
        'AR' => '阿肯色州',
        'CA' => '加利福尼亚州',
        'CO' => '科罗拉多州',
        'CT' => '康涅狄格州',
        'DE' => '特拉华州',
        'FL' => '佛罗里达州',
        'GA' => '佐治亚州',
        'HI' => '夏威夷州',
        'ID' => '爱达荷州',
        'IL' => '伊利诺伊州',
        'IN' => '印第安纳州',
        'IA' => '爱荷华州',
        'KS' => '堪萨斯州',
        'KY' => '肯塔基州',
        'LA' => '路易斯安那州',
        'ME' => '缅因州',
        'MD' => '马里兰州',
        'MA' => '马萨诸塞州',
        'MI' => '密歇根州',
        'MN' => '明尼苏达州',
        'MS' => '密西西比州',
        'MO' => '密苏里州',
        'MT' => '蒙大拿州',
        'NE' => '内布拉斯加州',
        'NV' => '内华达州',
        'NH' => '新罕布什尔州',
        'NJ' => '新泽西州',
        'NM' => '新墨西哥州',
        'NY' => '纽约州',
        'NC' => '北卡罗来纳州',
        'ND' => '北达科他州',
        'OH' => '俄亥俄州',
        'OK' => '俄克拉何马州',
        'OR' => '俄勒冈州',
        'PA' => '宾夕法尼亚州',
        'RI' => '罗得岛州',
        'SC' => '南卡罗来纳州',
        'SD' => '南达科他州',
        'TN' => '田纳西州',
        'TX' => '德克萨斯州',
        'UT' => '犹他州',
        'VT' => '佛蒙特州',
        'VA' => '弗吉尼亚州',
        'WA' => '华盛顿州',
        'WV' => '西弗吉尼亚州',
        'WI' => '威斯康星州',
        'WY' => '怀俄明州',
        'DC' => '哥伦比亚特区',
    ];
    $upper = strtoupper($raw);
    if (isset($abbrMap[$upper])) {
        return $abbrMap[$upper];
    }
    $nameMap = [
        'alabama' => '阿拉巴马州',
        'alaska' => '阿拉斯加州',
        'arizona' => '亚利桑那州',
        'arkansas' => '阿肯色州',
        'california' => '加利福尼亚州',
        'colorado' => '科罗拉多州',
        'connecticut' => '康涅狄格州',
        'delaware' => '特拉华州',
        'florida' => '佛罗里达州',
        'georgia' => '佐治亚州',
        'hawaii' => '夏威夷州',
        'idaho' => '爱达荷州',
        'illinois' => '伊利诺伊州',
        'indiana' => '印第安纳州',
        'iowa' => '爱荷华州',
        'kansas' => '堪萨斯州',
        'kentucky' => '肯塔基州',
        'louisiana' => '路易斯安那州',
        'maine' => '缅因州',
        'maryland' => '马里兰州',
        'massachusetts' => '马萨诸塞州',
        'michigan' => '密歇根州',
        'minnesota' => '明尼苏达州',
        'mississippi' => '密西西比州',
        'missouri' => '密苏里州',
        'montana' => '蒙大拿州',
        'nebraska' => '内布拉斯加州',
        'nevada' => '内华达州',
        'new hampshire' => '新罕布什尔州',
        'new jersey' => '新泽西州',
        'new mexico' => '新墨西哥州',
        'new york' => '纽约州',
        'north carolina' => '北卡罗来纳州',
        'north dakota' => '北达科他州',
        'ohio' => '俄亥俄州',
        'oklahoma' => '俄克拉何马州',
        'oregon' => '俄勒冈州',
        'pennsylvania' => '宾夕法尼亚州',
        'rhode island' => '罗得岛州',
        'south carolina' => '南卡罗来纳州',
        'south dakota' => '南达科他州',
        'tennessee' => '田纳西州',
        'texas' => '德克萨斯州',
        'utah' => '犹他州',
        'vermont' => '佛蒙特州',
        'virginia' => '弗吉尼亚州',
        'washington' => '华盛顿州',
        'west virginia' => '西弗吉尼亚州',
        'wisconsin' => '威斯康星州',
        'wyoming' => '怀俄明州',
        'district of columbia' => '哥伦比亚特区',
        'washington, d.c.' => '哥伦比亚特区',
    ];
    $lower = strtolower($raw);
    return $nameMap[$lower] ?? $region;
}

function normalize_ip_location(array $location): array {
    $country = trim((string)($location['country'] ?? ''));
    $countryCode = strtoupper(trim((string)($location['country_code'] ?? '')));
    $region = trim((string)($location['region'] ?? ''));
    $city = trim((string)($location['city'] ?? ''));
    $country = normalize_country_name($country, $countryCode);
    if ($countryCode === 'US') {
        $region = normalize_us_region($region);
    }
    return [
        'country' => $country,
        'country_code' => $countryCode,
        'region' => $region,
        'city' => $city,
    ];
}

function lookup_ip_location_cn(string $ip): array {
    $data = http_get_json('http://whois.pconline.com.cn/ipJson.jsp?ip=' . urlencode($ip) . '&json=true');
    if (!is_array($data)) {
        return ['country' => '', 'country_code' => '', 'region' => '', 'city' => ''];
    }
    $pro = trim((string)($data['pro'] ?? ''));
    $city = trim((string)($data['city'] ?? ''));
    $addr = trim((string)($data['addr'] ?? ''));
    $country = '';
    $region = '';
    $cityOut = '';
    $countryCode = '';
    if ($pro !== '' || $city !== '') {
        $country = '中国';
        $countryCode = 'CN';
        $region = $pro;
        $cityOut = $city;
    } elseif ($addr !== '') {
        $country = preg_replace('/\s+/', ' ', $addr);
        if (strpos($country, '中国') !== false) {
            $countryCode = 'CN';
        }
    }
    return [
        'country' => $country,
        'country_code' => $countryCode,
        'region' => $region,
        'city' => $cityOut,
    ];
}

function lookup_ip_location(string $ip): array {
    $ip = trim($ip);
    if ($ip === '') {
        return ['country' => '', 'country_code' => '', 'region' => '', 'city' => ''];
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM share_access_geo_cache WHERE ip = :ip LIMIT 1');
    $stmt->execute([':ip' => $ip]);
    $cached = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($cached) {
        $updatedAt = strtotime((string)($cached['updated_at'] ?? ''));
        if ($updatedAt && (time() - $updatedAt) < 86400 * 30) {
            $cachedLocation = [
                'country' => (string)($cached['country'] ?? ''),
                'country_code' => (string)($cached['country_code'] ?? ''),
                'region' => (string)($cached['region'] ?? ''),
                'city' => (string)($cached['city'] ?? ''),
            ];
            $text = ($cachedLocation['country'] ?? '') . ($cachedLocation['region'] ?? '') . ($cachedLocation['city'] ?? '');
            if ($text === '' || has_non_ascii($text)) {
                return normalize_ip_location($cachedLocation);
            }
        }
    }
    $location = lookup_ip_location_cn($ip);
    if (trim((string)($location['country'] ?? '')) === '') {
        $primary = http_get_json('http://ip-api.com/json/' . urlencode($ip) . '?fields=status,country,countryCode,regionName,city&lang=zh-CN');
        if (is_array($primary) && ($primary['status'] ?? '') === 'success') {
            $location = [
                'country' => (string)($primary['country'] ?? ''),
                'country_code' => (string)($primary['countryCode'] ?? ''),
                'region' => (string)($primary['regionName'] ?? ''),
                'city' => (string)($primary['city'] ?? ''),
            ];
        }
    }
    $stmt = $pdo->prepare('INSERT OR REPLACE INTO share_access_geo_cache (ip, country, country_code, region, city, updated_at)
        VALUES (:ip, :country, :code, :region, :city, :updated_at)');
    $location = normalize_ip_location($location);
    $stmt->execute([
        ':ip' => $ip,
        ':country' => $location['country'],
        ':code' => $location['country_code'],
        ':region' => $location['region'],
        ':city' => $location['city'],
        ':updated_at' => now(),
    ]);
    return $location;
}

function format_ip_location(array $location): string {
    $location = normalize_ip_location($location);
    $parts = [];
    foreach (['country', 'region', 'city'] as $key) {
        $val = trim((string)($location[$key] ?? ''));
        if ($val !== '') {
            $parts[] = $val;
        }
    }
    return implode(' / ', $parts);
}

function calculate_access_log_size(array $fields): int {
    $total = 32;
    foreach ($fields as $value) {
        $total += strlen((string)$value);
    }
    return $total;
}

function purge_share_access_logs(int $shareId): ?int {
    if ($shareId <= 0) {
        return null;
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT user_id, COALESCE(SUM(size_bytes), 0) AS total FROM share_access_logs WHERE share_id = :sid');
    $stmt->execute([':sid' => $shareId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    $userId = $row ? (int)$row['user_id'] : null;
    $total = $row ? (int)$row['total'] : 0;
    $pdo->prepare('DELETE FROM share_access_logs WHERE share_id = :sid')->execute([':sid' => $shareId]);
    if ($userId) {
        adjust_user_storage($userId, -$total);
    }
    return $userId;
}

function purge_user_access_logs(int $userId): int {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM share_access_logs WHERE user_id = :uid');
    $stmt->execute([':uid' => $userId]);
    $total = (int)($stmt->fetch(PDO::FETCH_ASSOC)['total'] ?? 0);
    $pdo->prepare('DELETE FROM share_access_logs WHERE user_id = :uid')->execute([':uid' => $userId]);
    adjust_user_storage($userId, -$total);
    return $total;
}

function cleanup_user_access_logs(int $userId, int $days): void {
    $days = max(1, $days);
    $cutoff = date('Y-m-d H:i:s', time() - ($days * 86400));
    $pdo = db();
    $stmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM share_access_logs WHERE user_id = :uid AND created_at < :cutoff');
    $stmt->execute([
        ':uid' => $userId,
        ':cutoff' => $cutoff,
    ]);
    $total = (int)($stmt->fetch(PDO::FETCH_ASSOC)['total'] ?? 0);
    if ($total <= 0) {
        return;
    }
    $pdo->prepare('DELETE FROM share_access_logs WHERE user_id = :uid AND created_at < :cutoff')->execute([
        ':uid' => $userId,
        ':cutoff' => $cutoff,
    ]);
    adjust_user_storage($userId, -$total);
}

function record_share_access(array $share, ?string $docId = null, ?string $docTitle = null): void {
    $userId = (int)($share['user_id'] ?? 0);
    if ($userId <= 0) {
        return;
    }
    if (!access_stats_enabled($userId)) {
        return;
    }
    $visitorId = get_visitor_id();
    $ip = get_client_ip();
    $referer = trim((string)($_SERVER['HTTP_REFERER'] ?? ''));
    $location = lookup_ip_location($ip);
    $size = calculate_access_log_size([
        $docId,
        $docTitle,
        $visitorId,
        $ip,
        $referer,
        $location['country'] ?? '',
        $location['region'] ?? '',
        $location['city'] ?? '',
    ]);
    $user = get_user_by_id($userId);
    if (!$user) {
        return;
    }
    $limit = get_user_limit_bytes($user);
    $used = (int)($user['storage_used_bytes'] ?? 0);
    if ($limit > 0 && ($used + $size) > $limit) {
        set_user_setting($userId, 'access_stats_enabled', '0');
        purge_user_access_logs($userId);
        return;
    }
    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO share_access_logs
        (user_id, share_id, doc_id, doc_title, visitor_id, ip, ip_country, ip_country_code, ip_region, ip_city, referer, created_at, size_bytes)
        VALUES (:uid, :sid, :doc_id, :doc_title, :visitor_id, :ip, :country, :country_code, :region, :city, :referer, :created_at, :size_bytes)');
    $stmt->execute([
        ':uid' => $userId,
        ':sid' => (int)($share['id'] ?? 0),
        ':doc_id' => $docId,
        ':doc_title' => $docTitle,
        ':visitor_id' => $visitorId,
        ':ip' => $ip,
        ':country' => (string)($location['country'] ?? ''),
        ':country_code' => (string)($location['country_code'] ?? ''),
        ':region' => (string)($location['region'] ?? ''),
        ':city' => (string)($location['city'] ?? ''),
        ':referer' => $referer,
        ':created_at' => now(),
        ':size_bytes' => $size,
    ]);
    adjust_user_storage($userId, $size);
    cleanup_user_access_logs($userId, access_stats_retention_days($userId));
}

function fetch_share_comments(int $shareId): array {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM share_comments WHERE share_id = :share_id ORDER BY created_at DESC, id DESC');
    $stmt->execute([':share_id' => $shareId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    return $rows ?: [];
}

function build_comment_tree(array $comments): array {
    $items = [];
    foreach ($comments as $comment) {
        $comment['children'] = [];
        $items[(int)$comment['id']] = $comment;
    }
    $roots = [];
    foreach ($items as $id => &$comment) {
        $parentId = (int)($comment['parent_id'] ?? 0);
        if ($parentId > 0 && isset($items[$parentId])) {
            $items[$parentId]['children'][] = &$comment;
        } else {
            $roots[] = &$comment;
        }
    }
    unset($comment);
    $sorter = static function (array $a, array $b): int {
        $aTime = (string)($a['created_at'] ?? '');
        $bTime = (string)($b['created_at'] ?? '');
        if ($aTime === $bTime) {
            return ((int)($b['id'] ?? 0)) <=> ((int)($a['id'] ?? 0));
        }
        return strcmp($bTime, $aTime);
    };
    $sortTree = static function (array &$nodes) use (&$sortTree, $sorter): void {
        usort($nodes, $sorter);
        foreach ($nodes as &$node) {
            if (!empty($node['children'])) {
                $sortTree($node['children']);
            }
        }
        unset($node);
    };
    $sortTree($roots);
    return $roots;
}

function can_delete_share_comment(array $comment, array $share, ?array $user): bool {
    $viewerId = $user ? (int)($user['id'] ?? 0) : 0;
    if ($viewerId > 0 && $viewerId === (int)$share['user_id']) {
        return true;
    }
    $commentUserId = (int)($comment['user_id'] ?? 0);
    if ($viewerId > 0 && $commentUserId > 0 && $viewerId === $commentUserId) {
        return true;
    }
    $visitorId = get_visitor_id();
    if ($visitorId !== '' && $visitorId === (string)($comment['visitor_id'] ?? '')) {
        return true;
    }
    return false;
}

function render_comment_markdown(string $markdown): string {
    static $parser = null;
    if (!$parser) {
        $parser = new Parsedown();
        if (method_exists($parser, 'setSafeMode')) {
            $parser->setSafeMode(true);
        }
        if (method_exists($parser, 'setBreaksEnabled')) {
            $parser->setBreaksEnabled(true);
        }
    }
    return $parser->text($markdown);
}

function format_comment_content(string $content): string {
    return render_comment_markdown($content);
}

function render_comment_emoji_picker(): string {
    $emojis = ['😀', '😁', '😂', '😅', '😊', '😍', '😘', '😎', '🤔', '😴', '😭', '😡', '👍', '🙏', '🎉', '❤️'];
    $html = '<div class="comment-emoji-panel" data-emoji-panel hidden>';
    foreach ($emojis as $emoji) {
        $html .= '<button class="comment-emoji" type="button" data-emoji="' . htmlspecialchars($emoji, ENT_QUOTES) . '">' . htmlspecialchars($emoji) . '</button>';
    }
    $html .= '</div>';
    return $html;
}

function render_comment_editor_fields(string $content = '', string $textareaName = 'content'): string {
    $html = '<div class="comment-editor" data-comment-editor>';
    $html .= '<div class="comment-toolbar">';
    $html .= '<button class="comment-tool" type="button" data-emoji-toggle aria-label="表情" title="表情">';
    $html .= '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"></circle><circle cx="9" cy="10" r="1.2" fill="currentColor"></circle><circle cx="15" cy="10" r="1.2" fill="currentColor"></circle><path d="M8 14c1.2 1.2 2.5 1.8 4 1.8 1.5 0 2.8-.6 4-1.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>';
    $html .= '</button>';
    $html .= '<button class="comment-tool" type="button" data-image-insert aria-label="图片" title="图片">';
    $html .= '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"></rect><circle cx="9" cy="11" r="2" fill="currentColor"></circle><path d="M21 16l-5-5-4 4-2-2-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
    $html .= '</button>';
    $html .= '<input class="comment-image-input" type="file" accept="image/*" data-image-input hidden>';
    $html .= render_comment_emoji_picker();
    $html .= '</div>';
    $html .= '<textarea class="input comment-input" name="' . htmlspecialchars($textareaName) . '" rows="4" placeholder="写下你的评论..." required>' . htmlspecialchars($content) . '</textarea>';
    $html .= '</div>';
    return $html;
}

function render_comment_form(string $action, ?string $docId, string $emailValue, ?int $parentId, string $buttonLabel, string $contentValue = ''): string {
    $html = '<form method="post" action="' . htmlspecialchars($action) . '" class="comment-form">';
    $html .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    if ($docId !== null && $docId !== '') {
        $html .= '<input type="hidden" name="doc_id" value="' . htmlspecialchars($docId) . '">';
    }
    if ($parentId) {
        $html .= '<input type="hidden" name="parent_id" value="' . (int)$parentId . '">';
    }
    $html .= '<div class="comment-grid">';
    $html .= '<div><label>邮箱</label><input class="input" name="email" type="email" value="' . htmlspecialchars($emailValue) . '" placeholder="name@example.com" required></div>';
    $html .= '<div class="comment-wide"><label>评论</label>' . render_comment_editor_fields($contentValue, 'content') . '</div>';
    if (captcha_enabled()) {
        $html .= '<div class="comment-captcha"><label>验证码</label><div class="comment-captcha-row">';
        $html .= '<input class="input" name="captcha" placeholder="验证码" required>';
        $html .= '<img class="captcha-img" src="' . htmlspecialchars(captcha_url()) . '" alt="验证码" data-captcha>';
        $html .= '</div></div>';
    }
    $html .= '</div>';
    $html .= '<button class="button primary" type="submit">' . htmlspecialchars($buttonLabel) . '</button>';
    $html .= '</form>';
    return $html;
}

function render_comment_node(array $comment, array $share, ?array $user, string $slug, ?string $docId, int $depth, array $indexMap): string {
    $commentId = (int)($comment['id'] ?? 0);
    $rawEmail = (string)($comment['email'] ?? '');
    $email = mask_email($rawEmail);
    $created = format_share_datetime((string)($comment['created_at'] ?? ''));
    $rawContent = (string)($comment['content'] ?? '');
    $content = format_comment_content($rawContent);
    $isOwner = (int)($comment['user_id'] ?? 0) === (int)$share['user_id'];
    $viewerIsOwner = $user && (int)($user['id'] ?? 0) === (int)$share['user_id'];
    $avatarSeed = $rawEmail !== '' ? $rawEmail : '访客';
    $avatarLabel = function_exists('mb_substr')
        ? mb_substr($avatarSeed, 0, 1, 'UTF-8')
        : substr($avatarSeed, 0, 1);
    $authorLabel = $email !== '' ? $email : '访客';
    $metaParts = [];
    if ($created !== '') {
        $metaParts[] = $created;
    }
    $metaLabel = $metaParts ? implode(' - ', $metaParts) : '';

    $html = '<div class="comment-item" style="--comment-depth:' . $depth . '" id="comment-' . $commentId . '">';
    $index = $indexMap[$commentId] ?? 0;
    $html .= '<div class="comment-card">';
    $html .= '<div class="comment-body">';
    $html .= '<div class="comment-head">';
    if ($index > 0) {
        $html .= '<span class="comment-index">' . $index . '</span>';
    }
    $html .= '<div class="comment-author">' . htmlspecialchars($authorLabel) . '</div>';
    if ($isOwner) {
        $html .= '<span class="comment-badge">分享者</span>';
    }
    if ($metaLabel !== '') {
        $html .= '<span class="comment-time">' . htmlspecialchars($metaLabel) . '</span>';
    }
    $html .= '<details class="comment-menu">';
    $html .= '<summary class="comment-menu-trigger" aria-label="更多操作">...</summary>';
    $html .= '<div class="comment-menu-list">';
    $html .= '<button class="comment-menu-item" type="button" data-comment-action="edit" data-comment-id="' . $commentId . '" data-comment-content="' . htmlspecialchars($rawContent, ENT_QUOTES) . '" data-comment-email="' . htmlspecialchars($authorLabel, ENT_QUOTES) . '">编辑</button>';
    $html .= '<button class="comment-menu-item" type="button" data-comment-action="delete" data-comment-id="' . $commentId . '" data-comment-email="' . htmlspecialchars($authorLabel, ENT_QUOTES) . '" data-comment-owner="' . ($viewerIsOwner ? '1' : '0') . '">删除</button>';
    $html .= '</div>';
    $html .= '</details>';
    $html .= '</div>';
    $html .= '<div class="comment-content">' . $content . '</div>';
    $html .= '<div class="comment-footer">';
    $html .= '<button class="comment-reply-btn" type="button" data-comment-action="reply" data-comment-parent-id="' . $commentId . '" data-comment-email="' . htmlspecialchars($authorLabel, ENT_QUOTES) . '" data-comment-author="' . htmlspecialchars($authorLabel, ENT_QUOTES) . '">回复</button>';
    $html .= '</div>';
    $html .= '</div>';
    $html .= '</div>';
    if (!empty($comment['children'])) {
        $html .= '<div class="comment-children">';
        foreach ($comment['children'] as $child) {
            $html .= render_comment_node($child, $share, $user, $slug, $docId, $depth + 1, $indexMap);
        }
        $html .= '</div>';
    }
    $html .= '</div>';
    return $html;
}

function render_share_comments(array $share, ?array $user, ?string $docId = null): string {
    $shareId = (int)($share['id'] ?? 0);
    $slug = (string)($share['slug'] ?? '');
    if ($shareId <= 0 || $slug === '') {
        return '';
    }
    $comments = fetch_share_comments($shareId);
    $tree = build_comment_tree($comments);
    $order = $comments;
    usort($order, function ($a, $b) {
        $timeA = strtotime((string)($a['created_at'] ?? '')) ?: 0;
        $timeB = strtotime((string)($b['created_at'] ?? '')) ?: 0;
        if ($timeA === $timeB) {
            return (int)($a['id'] ?? 0) <=> (int)($b['id'] ?? 0);
        }
        return $timeA <=> $timeB;
    });
    $indexMap = [];
    $i = 1;
    foreach ($order as $row) {
        $id = (int)($row['id'] ?? 0);
        if ($id > 0) {
            $indexMap[$id] = $i;
            $i++;
        }
    }
    $emailValue = $user ? (string)($user['email'] ?? '') : '';
    $error = flash('comment_error');
    $info = flash('comment_info');
    $formStateRaw = flash('comment_form');
    $formState = [];
    if ($formStateRaw) {
        $decoded = json_decode($formStateRaw, true);
        if (is_array($decoded)) {
            $formState = $decoded;
        }
    }
    $formMode = (string)($formState['mode'] ?? '');
    $formEmail = (string)($formState['email'] ?? '');
    $formContent = (string)($formState['content'] ?? '');
    $formParentId = (int)($formState['parent_id'] ?? 0);
    $formNote = (string)($formState['note'] ?? '');
    $commentFormEmail = $emailValue;
    $commentFormContent = '';
    if ($formMode === 'comment') {
        if ($formEmail !== '') {
            $commentFormEmail = $formEmail;
        }
        $commentFormContent = $formContent;
    }
    $modalReopen = $formMode === 'reply';
    $modalEmail = $modalReopen ? $formEmail : '';
    $modalContent = $modalReopen ? $formContent : '';
    $modalParentId = $modalReopen ? $formParentId : 0;
    $modalNote = $modalReopen ? $formNote : '';
    $actionBase = base_path() . '/s/' . $slug;
    $uploadAction = $actionBase . '/comment/upload';
    $docValue = ($docId !== null && $docId !== '') ? (string)$docId : '';
    $viewerIsOwner = $user && (int)($user['id'] ?? 0) === (int)$share['user_id'];
    $html = '<section class="share-comments" id="comments" data-comment-upload="' . htmlspecialchars($uploadAction) . '">';
    $html .= '<div class="comment-header">';
    $html .= '<h2>评论</h2>';
    $html .= '<div class="comment-count">' . count($comments) . ' 条评论</div>';
    $html .= '</div>';
    if ($error) {
        $html .= '<div class="flash comment-flash error">' . htmlspecialchars($error) . '</div>';
    }
    if ($info) {
        $html .= '<div class="flash comment-flash">' . htmlspecialchars($info) . '</div>';
    }
    if (empty($tree)) {
        $html .= '<p class="muted">暂无评论，欢迎第一个留言。</p>';
    } else {
        $html .= '<div class="comment-list">';
        foreach ($tree as $comment) {
            $html .= render_comment_node($comment, $share, $user, $slug, $docId, 0, $indexMap);
        }
        $html .= '</div>';
    }
    $html .= render_comment_form($actionBase . '/comment', $docId, $commentFormEmail, null, '发表评论', $commentFormContent);
    $html .= '<div class="modal comment-modal" data-comment-modal data-comment-action-base="' . htmlspecialchars($actionBase) . '" data-comment-doc-id="' . htmlspecialchars($docValue) . '" data-comment-owner="' . ($viewerIsOwner ? '1' : '0') . '" data-comment-default-email="' . htmlspecialchars($emailValue) . '" data-comment-reopen="' . ($modalReopen ? '1' : '0') . '" data-comment-reopen-mode="reply" data-comment-reopen-parent="' . (int)$modalParentId . '" data-comment-reopen-email="' . htmlspecialchars($modalEmail, ENT_QUOTES) . '" data-comment-reopen-content="' . htmlspecialchars($modalContent, ENT_QUOTES) . '" data-comment-reopen-note="' . htmlspecialchars($modalNote, ENT_QUOTES) . '" hidden>';
    $html .= '<div class="modal-backdrop" data-modal-close></div>';
    $html .= '<div class="modal-card">';
    $html .= '<div class="modal-header" data-comment-modal-title>回复评论</div>';
    $html .= '<div class="modal-body">';
    $html .= '<form method="post" action="' . htmlspecialchars($actionBase . '/comment') . '" data-comment-form>';
    $html .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $html .= '<input type="hidden" name="doc_id" value="' . htmlspecialchars($docValue) . '" data-comment-doc>';
    $html .= '<input type="hidden" name="comment_id" value="" data-comment-id>';
    $html .= '<input type="hidden" name="parent_id" value="" data-comment-parent>';
    $html .= '<div class="comment-modal-note" data-comment-modal-note></div>';
    $html .= '<div class="comment-modal-fields" data-comment-verify>';
    $html .= '<div><label>邮箱</label><input class="input" name="email" type="email" value="" placeholder="name@example.com" required></div>';
    if (captcha_enabled()) {
        $html .= '<div class="comment-captcha"><label>验证码</label><div class="comment-captcha-row">';
        $html .= '<input class="input" name="captcha" placeholder="验证码" required>';
        $html .= '<img class="captcha-img" src="' . htmlspecialchars(captcha_url()) . '" alt="验证码" data-captcha>';
        $html .= '</div></div>';
    }
    $html .= '</div>';
    $html .= '<div class="comment-modal-fields" data-comment-editor-wrapper>';
    $html .= render_comment_editor_fields($modalContent, 'content');
    $html .= '</div>';
    $html .= '<div class="modal-actions">';
    $html .= '<button class="button ghost" type="button" data-modal-close>取消</button>';
    $html .= '<button class="button primary" type="submit" data-comment-submit>提交</button>';
    $html .= '</div>';
    $html .= '</form>';
    $html .= '</div>';
    $html .= '</div>';
    $html .= '</div>';
    $html .= '</section>';
    return $html;
}

function report_reason_options(): array {
    return [
        ['value' => 'illegal', 'label' => '违法违规'],
        ['value' => 'spam', 'label' => '垃圾广告/引流'],
        ['value' => 'infringe', 'label' => '侵权/盗用'],
        ['value' => 'other', 'label' => '其他'],
    ];
}

function report_reason_label(string $value): string {
    foreach (report_reason_options() as $option) {
        if ($option['value'] === $value) {
            return $option['label'];
        }
    }
    return $value;
}

function share_report_modal_id(string $slug): string {
    return 'report-modal-' . $slug;
}

function render_share_report_trigger(array $share): string {
    $slug = (string)($share['slug'] ?? '');
    if ($slug === '') {
        return '';
    }
    $modalId = share_report_modal_id($slug);
    return '<button class="kb-chip report-trigger" id="report" type="button" data-report-open data-report-target="' . htmlspecialchars($modalId) . '">举报</button>';
}

function render_share_report_form(array $share, ?array $user, ?string $docId = null): string {
    $slug = (string)($share['slug'] ?? '');
    if ($slug === '') {
        return '';
    }
    $error = flash('report_error');
    $info = flash('report_info');
    $action = base_path() . '/s/' . $slug . '/report';
    $modalId = share_report_modal_id($slug);
    $emailValue = $user ? (string)($user['email'] ?? '') : '';
    $formStateRaw = flash('report_form');
    $formState = [];
    if ($formStateRaw) {
        $decoded = json_decode($formStateRaw, true);
        if (is_array($decoded)) {
            $formState = $decoded;
        }
    }
    $reportEmailValue = $emailValue;
    $formEmail = (string)($formState['email'] ?? '');
    if ($formEmail !== '') {
        $reportEmailValue = $formEmail;
    }
    $formReason = (string)($formState['reason_type'] ?? '');
    $formDetail = (string)($formState['reason_detail'] ?? '');

    $html = '';
    if ($info) {
        $html .= '<div class="flash report-flash">' . htmlspecialchars($info) . '</div>';
    }
    $modalHidden = $error ? '' : ' hidden';
    $html .= '<div class="modal report-modal" id="' . htmlspecialchars($modalId) . '" data-report-modal' . $modalHidden . '>';
    $html .= '<div class="modal-backdrop" data-modal-close></div>';
    $html .= '<div class="modal-card">';
    $html .= '<div class="modal-header">举报内容</div>';
    $html .= '<div class="modal-body">';
    if ($error) {
        $html .= '<div class="alert error">' . htmlspecialchars($error) . '</div>';
    }
    $html .= '<form method="post" action="' . htmlspecialchars($action) . '" class="report-form">';
    $html .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    if ($docId !== null && $docId !== '') {
        $html .= '<input type="hidden" name="doc_id" value="' . htmlspecialchars($docId) . '">';
    }
    $html .= '<div class="report-grid">';
    $html .= '<div><label>举报类型</label><select class="input" name="reason_type" required>';
    foreach (report_reason_options() as $option) {
        $value = (string)($option['value'] ?? '');
        $selected = ($formReason !== '' && $formReason === $value) ? ' selected' : '';
        $html .= '<option value="' . htmlspecialchars($value) . '"' . $selected . '>' . htmlspecialchars($option['label']) . '</option>';
    }
    $html .= '</select></div>';
    $html .= '<div><label>邮箱</label><input class="input" type="email" name="report_email" value="' . htmlspecialchars($reportEmailValue) . '" placeholder="name@example.com" required></div>';
    $html .= '<div class="report-wide"><label>补充说明</label><textarea class="input" name="reason_detail" rows="4" placeholder="请补充说明原因" required>' . htmlspecialchars($formDetail) . '</textarea></div>';
    if (captcha_enabled()) {
        $html .= '<div class="report-captcha">';
        $html .= '<label>验证码</label><div class="report-captcha-row">';
        $html .= '<input class="input" name="captcha" placeholder="验证码" required>';
        $html .= '<img class="captcha-img" src="' . htmlspecialchars(captcha_url()) . '" alt="验证码" data-captcha>';
        $html .= '</div></div>';
    }
    $html .= '</div>';
    $html .= '<div class="modal-actions">';
    $html .= '<button class="button ghost" type="button" data-modal-close>取消</button>';
    $html .= '<button class="button primary" type="submit">提交举报</button>';
    $html .= '</div>';
    $html .= '</form>';
    $html .= '</div>';
    $html .= '</div>';
    $html .= '</div>';
    return $html;
}

function pending_report_count(): int {
    $pdo = db();
    $stmt = $pdo->query('SELECT COUNT(*) FROM share_reports WHERE handled_at IS NULL');
    return (int)$stmt->fetchColumn();
}

function build_share_redirect_path(string $slug, ?string $docId, string $anchor): string {
    $path = '/s/' . $slug;
    if ($docId !== null && $docId !== '') {
        $path .= '/' . rawurlencode($docId);
    }
    if ($anchor !== '') {
        $path .= '#' . $anchor;
    }
    return $path;
}

function collect_comment_tree_ids(array $rows, int $rootId): array {
    $children = [];
    $sizes = [];
    foreach ($rows as $row) {
        $id = (int)($row['id'] ?? 0);
        if ($id <= 0) {
            continue;
        }
        $parent = (int)($row['parent_id'] ?? 0);
        $children[$parent][] = $id;
        $sizes[$id] = (int)($row['size_bytes'] ?? 0);
    }
    $stack = [$rootId];
    $ids = [];
    $total = 0;
    while (!empty($stack)) {
        $id = array_pop($stack);
        if (!isset($sizes[$id])) {
            continue;
        }
        $ids[] = $id;
        $total += $sizes[$id];
        foreach ($children[$id] ?? [] as $childId) {
            $stack[] = $childId;
        }
    }
    return [$ids, $total];
}

function handle_share_comment_upload(string $slug): void {
    check_csrf();
    $share = find_share_by_slug($slug);
    if (!$share) {
        api_response(404, null, '分享不存在');
    }
    if (share_is_expired($share) || share_visitor_limit_reached($share)) {
        api_response(403, null, '分享已关闭，无法上传图片');
    }
    if (share_requires_password($share) && !share_access_granted((int)$share['id'])) {
        api_response(403, null, '请先输入访问密码');
    }
    $file = $_FILES['image'] ?? null;
    if (!$file || !is_array($file)) {
        api_response(400, null, '请选择图片文件');
    }
    $error = (int)($file['error'] ?? UPLOAD_ERR_NO_FILE);
    if ($error !== UPLOAD_ERR_OK) {
        api_response(400, null, '图片上传失败');
    }
    $tmp = (string)($file['tmp_name'] ?? '');
    if ($tmp === '' || !is_uploaded_file($tmp)) {
        api_response(400, null, '图片上传失败');
    }
    $info = @getimagesize($tmp);
    if (!$info) {
        api_response(400, null, '仅支持图片文件');
    }
    $type = (int)($info[2] ?? 0);
    $ext = strtolower((string)image_type_to_extension($type, false));
    $allowed = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
    if ($ext === '' || !in_array($ext, $allowed, true)) {
        $name = (string)($file['name'] ?? '');
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        if ($ext === '' || !in_array($ext, $allowed, true)) {
            api_response(400, null, '仅支持图片文件');
        }
    }
    $owner = get_user_by_id((int)$share['user_id']);
    if (!$owner) {
        api_response(400, null, '分享所属用户不存在');
    }
    $size = (int)($file['size'] ?? 0);
    if ($size <= 0 && is_file($tmp)) {
        $size = (int)filesize($tmp);
    }
    $used = recalculate_user_storage((int)$owner['id']);
    $limit = get_user_limit_bytes($owner);
    if ($limit > 0 && ($used + $size) > $limit) {
        api_response(413, null, '存储空间不足');
    }
    $shareId = (int)$share['id'];
    $filename = bin2hex(random_bytes(8)) . '.' . $ext;
    global $config;
    $assetPath = comment_asset_prefix() . $shareId . '/' . $filename;
    $dir = $config['uploads_dir'] . '/' . trim(comment_asset_prefix(), '/') . '/' . $shareId;
    ensure_dir($dir);
    $target = $dir . '/' . $filename;
    if (!move_uploaded_file($tmp, $target)) {
        api_response(500, null, '图片保存失败');
    }
    $actualSize = $size;
    if ($actualSize <= 0 && is_file($target)) {
        $actualSize = (int)filesize($target);
    }
    $pdo = db();
    $stmt = $pdo->prepare('INSERT OR REPLACE INTO share_assets (share_id, doc_id, asset_path, file_path, size_bytes, created_at)
        VALUES (:share_id, :doc_id, :asset_path, :file_path, :size_bytes, :created_at)');
    $stmt->execute([
        ':share_id' => $shareId,
        ':doc_id' => null,
        ':asset_path' => $assetPath,
        ':file_path' => $assetPath,
        ':size_bytes' => $actualSize,
        ':created_at' => now(),
    ]);
    adjust_share_size($shareId, $actualSize);
    adjust_user_storage((int)$owner['id'], $actualSize);
    $url = base_path() . '/uploads/' . $assetPath;
    api_response(200, ['url' => $url, 'size' => $actualSize]);
}

function handle_share_comment_submit(string $slug): void {
    check_csrf();
    $share = find_share_by_slug($slug);
    if (!$share) {
        http_response_code(404);
        echo '分享不存在';
        exit;
    }
    $docId = trim((string)($_POST['doc_id'] ?? ''));
    $redirectPath = build_share_redirect_path($slug, $docId, 'comments');
    if (share_is_expired($share) || share_visitor_limit_reached($share)) {
        flash('comment_error', '分享已关闭，无法评论');
        redirect($redirectPath);
    }
    if (share_requires_password($share) && !share_access_granted((int)$share['id'])) {
        flash('comment_error', '请先输入访问密码');
        redirect($redirectPath);
    }
    $email = trim((string)($_POST['email'] ?? ''));
    $content = trim((string)($_POST['content'] ?? ''));
    $parentId = max(0, (int)($_POST['parent_id'] ?? 0));
    $shareId = (int)$share['id'];
    $parentEmail = '';
    if ($parentId > 0) {
        $pdo = db();
        $check = $pdo->prepare('SELECT email FROM share_comments WHERE id = :id AND share_id = :share_id');
        $check->execute([':id' => $parentId, ':share_id' => $shareId]);
        $row = $check->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            flash('comment_error', '回复目标不存在');
            redirect($redirectPath);
        }
        $parentEmail = trim((string)($row['email'] ?? ''));
    }
    if (captcha_enabled()) {
        $captchaInput = (string)($_POST['captcha'] ?? '');
        if (!check_captcha($captchaInput)) {
            $state = [
                'mode' => $parentId > 0 ? 'reply' : 'comment',
                'email' => $email,
                'content' => $content,
                'parent_id' => $parentId > 0 ? $parentId : 0,
                'note' => $parentEmail !== '' ? mask_email($parentEmail) : '',
            ];
            flash('comment_form', json_encode($state, JSON_UNESCAPED_UNICODE));
            flash('comment_error', '验证码不对');
            redirect($redirectPath);
        }
    }
    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        flash('comment_error', '请输入有效邮箱');
        redirect($redirectPath);
    }
    if ($content === '') {
        flash('comment_error', '评论内容不能为空');
        redirect($redirectPath);
    }
    $contentLength = function_exists('mb_strlen') ? mb_strlen($content, 'UTF-8') : strlen($content);
    if ($contentLength > 2000) {
        flash('comment_error', '评论内容过长');
        redirect($redirectPath);
    }
    $bannedWords = get_banned_words();
    if (!empty($bannedWords)) {
        $hit = find_banned_word($content, $bannedWords);
        if ($hit) {
            $state = [
                'mode' => $parentId > 0 ? 'reply' : 'comment',
                'email' => $email,
                'content' => $content,
                'parent_id' => $parentId > 0 ? $parentId : 0,
                'note' => $parentEmail !== '' ? mask_email($parentEmail) : '',
            ];
            flash('comment_form', json_encode($state, JSON_UNESCAPED_UNICODE));
            flash('comment_error', '触发违禁词：' . $hit['word']);
            redirect($redirectPath);
        }
    }
    $owner = get_user_by_id((int)$share['user_id']);
    if (!$owner) {
        flash('comment_error', '分享所属用户不存在');
        redirect($redirectPath);
    }
    $size = calculate_comment_size($email, $content);
    $used = recalculate_user_storage((int)$owner['id']);
    $limit = get_user_limit_bytes($owner);
    if ($limit > 0 && ($used + $size) > $limit) {
        flash('comment_error', '存储空间不足，无法发表评论');
        redirect($redirectPath);
    }
    $viewer = current_user();
    $userId = $viewer ? (int)$viewer['id'] : null;
    $visitorId = get_visitor_id();
    $ip = get_client_ip();
    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO share_comments (share_id, parent_id, user_id, visitor_id, email, content, ip, size_bytes, created_at)
        VALUES (:share_id, :parent_id, :user_id, :visitor_id, :email, :content, :ip, :size_bytes, :created_at)');
    $stmt->execute([
        ':share_id' => $shareId,
        ':parent_id' => $parentId > 0 ? $parentId : null,
        ':user_id' => $userId,
        ':visitor_id' => $visitorId !== '' ? $visitorId : null,
        ':email' => $email,
        ':content' => $content,
        ':ip' => $ip,
        ':size_bytes' => $size,
        ':created_at' => now(),
    ]);
    $commentId = (int)$pdo->lastInsertId();
    adjust_share_size($shareId, $size);
    adjust_user_storage((int)$owner['id'], $size);
    if ((int)($share['comment_notify'] ?? 0) === 1 && smtp_enabled()) {
        $recipientEmail = '';
        $isReply = false;
        if ($parentId > 0) {
            $recipientEmail = $parentEmail;
            $isReply = true;
        } else {
            $recipientEmail = trim((string)($owner['email'] ?? ''));
        }
        if ($recipientEmail !== '' && $email !== '' && strcasecmp($recipientEmail, $email) === 0) {
            $recipientEmail = '';
        }
        if ($recipientEmail !== '') {
            $commentPayload = [
                'id' => $commentId,
                'email' => $email,
                'content' => $content,
            ];
            enqueue_background_task(function () use ($share, $commentPayload, $recipientEmail, $isReply) {
                send_comment_notification($share, $commentPayload, $recipientEmail, $isReply);
            });
        }
    }
    $anchor = $commentId > 0 ? 'comment-' . $commentId : 'comments';
    flash('comment_info', '评论已提交');
    redirect(build_share_redirect_path($slug, $docId, $anchor));
}

function handle_share_comment_delete(string $slug): void {
    check_csrf();
    $share = find_share_by_slug($slug);
    if (!$share) {
        http_response_code(404);
        echo '分享不存在';
        exit;
    }
    $docId = trim((string)($_POST['doc_id'] ?? ''));
    $redirectPath = build_share_redirect_path($slug, $docId, 'comments');
    if (share_requires_password($share) && !share_access_granted((int)$share['id'])) {
        flash('comment_error', '请先输入访问密码');
        redirect($redirectPath);
    }
    $commentId = max(0, (int)($_POST['comment_id'] ?? 0));
    if ($commentId <= 0) {
        flash('comment_error', '缺少评论ID');
        redirect($redirectPath);
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM share_comments WHERE id = :id AND share_id = :share_id');
    $stmt->execute([':id' => $commentId, ':share_id' => (int)$share['id']]);
    $comment = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$comment) {
        flash('comment_error', '评论不存在');
        redirect($redirectPath);
    }
    $viewer = current_user();
    $viewerId = $viewer ? (int)($viewer['id'] ?? 0) : 0;
    $isShareOwner = $viewerId > 0 && $viewerId === (int)$share['user_id'];
    if (!$isShareOwner) {
        if (captcha_enabled()) {
            $captchaInput = (string)($_POST['captcha'] ?? '');
            if (!check_captcha($captchaInput)) {
                flash('comment_error', '验证码错误');
                redirect($redirectPath);
            }
        }
        $email = trim((string)($_POST['email'] ?? ''));
        if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            flash('comment_error', '请输入有效邮箱');
            redirect($redirectPath);
        }
        $commentEmail = (string)($comment['email'] ?? '');
        if ($commentEmail === '' || strcasecmp($email, $commentEmail) !== 0) {
            flash('comment_error', '邮箱验证失败');
            redirect($redirectPath);
        }
    }
    $shareId = (int)$share['id'];
    $stmt = $pdo->prepare('SELECT id, parent_id, size_bytes, content FROM share_comments WHERE share_id = :share_id');
    $stmt->execute([':share_id' => $shareId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    [$ids, $totalSize] = collect_comment_tree_ids($rows, $commentId);
    $assetPaths = [];
    if (!empty($ids)) {
        $idLookup = array_fill_keys($ids, true);
        foreach ($rows as $row) {
            $rowId = (int)($row['id'] ?? 0);
            if (!isset($idLookup[$rowId])) {
                continue;
            }
            $content = (string)($row['content'] ?? '');
            $assetPaths = array_merge($assetPaths, extract_comment_asset_paths($content, $shareId));
        }
        if (!empty($assetPaths)) {
            $assetPaths = array_values(array_unique($assetPaths));
            $assetPaths = filter_unused_comment_assets($shareId, $assetPaths, $ids);
        }
    }
    if (!empty($ids)) {
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $params = $ids;
        $params[] = $shareId;
        $del = $pdo->prepare('DELETE FROM share_comments WHERE id IN (' . $placeholders . ') AND share_id = ?');
        $del->execute($params);
    }
    $assetSize = delete_comment_assets($shareId, $assetPaths);
    $delta = -$totalSize - $assetSize;
    if ($delta !== 0) {
        adjust_share_size($shareId, $delta);
        adjust_user_storage((int)$share['user_id'], $delta);
    }
    flash('comment_info', '评论已删除');
    redirect($redirectPath);
}

function handle_share_comment_edit(string $slug): void {
    check_csrf();
    $share = find_share_by_slug($slug);
    if (!$share) {
        http_response_code(404);
        echo '分享不存在';
        exit;
    }
    $docId = trim((string)($_POST['doc_id'] ?? ''));
    $redirectPath = build_share_redirect_path($slug, $docId, 'comments');
    if (share_requires_password($share) && !share_access_granted((int)$share['id'])) {
        flash('comment_error', '请先输入访问密码');
        redirect($redirectPath);
    }
    $commentId = max(0, (int)($_POST['comment_id'] ?? 0));
    if ($commentId <= 0) {
        flash('comment_error', '缺少评论ID');
        redirect($redirectPath);
    }
    if (captcha_enabled()) {
        $captchaInput = (string)($_POST['captcha'] ?? '');
        if (!check_captcha($captchaInput)) {
            flash('comment_error', '验证码错误');
            redirect($redirectPath);
        }
    }
    $email = trim((string)($_POST['email'] ?? ''));
    $content = trim((string)($_POST['content'] ?? ''));
    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        flash('comment_error', '请输入有效邮箱');
        redirect($redirectPath);
    }
    if ($content === '') {
        flash('comment_error', '评论内容不能为空');
        redirect($redirectPath);
    }
    $contentLength = function_exists('mb_strlen') ? mb_strlen($content, 'UTF-8') : strlen($content);
    if ($contentLength > 2000) {
        flash('comment_error', '评论内容过长');
        redirect($redirectPath);
    }
    $bannedWords = get_banned_words();
    if (!empty($bannedWords)) {
        $hit = find_banned_word($content, $bannedWords);
        if ($hit) {
            flash('comment_error', '触发违禁词：' . $hit['word']);
            redirect($redirectPath);
        }
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM share_comments WHERE id = :id AND share_id = :share_id');
    $stmt->execute([':id' => $commentId, ':share_id' => (int)$share['id']]);
    $comment = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$comment) {
        flash('comment_error', '评论不存在');
        redirect($redirectPath);
    }
    $commentEmail = (string)($comment['email'] ?? '');
    $commentEmailMasked = $commentEmail !== '' ? mask_email($commentEmail) : '';
    if ($commentEmail === '' || strcasecmp($email, $commentEmail) !== 0) {
        flash('comment_error', '邮箱验证失败');
        redirect($redirectPath);
    }
    $shareId = (int)$share['id'];
    $newSize = calculate_comment_size($commentEmail, $content);
    $oldSize = (int)($comment['size_bytes'] ?? 0);
    $oldAssets = extract_comment_asset_paths((string)($comment['content'] ?? ''), $shareId);
    $newAssets = extract_comment_asset_paths($content, $shareId);
    $removeAssets = array_values(array_diff($oldAssets, $newAssets));
    if (!empty($removeAssets)) {
        $removeAssets = filter_unused_comment_assets($shareId, $removeAssets, [$commentId]);
    }
    $removeAssetSize = sum_share_asset_sizes($shareId, $removeAssets);
    $delta = $newSize - $oldSize;
    $netDelta = $delta - $removeAssetSize;
    if ($netDelta > 0) {
        $owner = get_user_by_id((int)$share['user_id']);
        if (!$owner) {
            flash('comment_error', '分享所属用户不存在');
            redirect($redirectPath);
        }
        $used = recalculate_user_storage((int)$owner['id']);
        $limit = get_user_limit_bytes($owner);
        if ($limit > 0 && ($used + $netDelta) > $limit) {
            flash('comment_error', '存储空间不足，无法保存修改');
            redirect($redirectPath);
        }
    }
    $update = $pdo->prepare('UPDATE share_comments SET content = :content, size_bytes = :size_bytes WHERE id = :id AND share_id = :share_id');
    $update->execute([
        ':content' => $content,
        ':size_bytes' => $newSize,
        ':id' => $commentId,
        ':share_id' => (int)$share['id'],
    ]);
    $deletedAssetSize = delete_comment_assets($shareId, $removeAssets);
    $totalDelta = $delta - $deletedAssetSize;
    if ($totalDelta !== 0) {
        adjust_share_size($shareId, $totalDelta);
        adjust_user_storage((int)$share['user_id'], $totalDelta);
    }
    $anchor = 'comment-' . $commentId;
    flash('comment_info', '评论已更新');
    redirect(build_share_redirect_path($slug, $docId, $anchor));
}

function handle_share_report_submit(string $slug): void {
    check_csrf();
    $share = find_share_by_slug($slug);
    if (!$share) {
        http_response_code(404);
        echo '分享不存在';
        exit;
    }
    $docId = trim((string)($_POST['doc_id'] ?? ''));
    $redirectPath = build_share_redirect_path($slug, $docId, 'report');
    if (share_requires_password($share) && !share_access_granted((int)$share['id'])) {
        flash('report_error', '请先输入访问密码');
        redirect($redirectPath);
    }
    $reportEmail = trim((string)($_POST['report_email'] ?? ''));
    $reasonType = trim((string)($_POST['reason_type'] ?? ''));
    $reasonDetail = trim((string)($_POST['reason_detail'] ?? ''));
    if (captcha_enabled()) {
        $captchaInput = (string)($_POST['captcha'] ?? '');
        if (!check_captcha($captchaInput)) {
            $state = [
                'email' => $reportEmail,
                'reason_type' => $reasonType,
                'reason_detail' => $reasonDetail,
            ];
            flash('report_form', json_encode($state, JSON_UNESCAPED_UNICODE));
            flash('report_error', '验证码不对');
            redirect($redirectPath);
        }
    }
    if ($reportEmail === '' || !filter_var($reportEmail, FILTER_VALIDATE_EMAIL)) {
        flash('report_error', '请输入有效邮箱');
        redirect($redirectPath);
    }
    $validReasons = array_column(report_reason_options(), 'value');
    if ($reasonType === '' || !in_array($reasonType, $validReasons, true)) {
        flash('report_error', '请选择举报类型');
        redirect($redirectPath);
    }
    if ($reasonDetail === '') {
        flash('report_error', '请填写举报说明');
        redirect($redirectPath);
    }
    $detailLength = function_exists('mb_strlen') ? mb_strlen($reasonDetail, 'UTF-8') : strlen($reasonDetail);
    if ($detailLength > 1000) {
        flash('report_error', '举报说明过长');
        redirect($redirectPath);
    }
    $viewer = current_user();
    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO share_reports (share_id, share_title, share_slug, share_user_id, reporter_user_id, report_email, visitor_id, ip, reason_type, reason_detail, created_at)
        VALUES (:share_id, :share_title, :share_slug, :share_user_id, :reporter_user_id, :report_email, :visitor_id, :ip, :reason_type, :reason_detail, :created_at)');
    $stmt->execute([
        ':share_id' => (int)$share['id'],
        ':share_title' => (string)($share['title'] ?? $slug),
        ':share_slug' => (string)($share['slug'] ?? $slug),
        ':share_user_id' => (int)$share['user_id'],
        ':reporter_user_id' => $viewer ? (int)$viewer['id'] : null,
        ':report_email' => $reportEmail,
        ':visitor_id' => get_visitor_id(),
        ':ip' => get_client_ip(),
        ':reason_type' => $reasonType,
        ':reason_detail' => $reasonDetail,
        ':created_at' => now(),
    ]);
    flash('report_info', '举报已提交，感谢反馈');
    redirect($redirectPath);
}

function build_from_header(string $from, string $name): string {
    $name = trim($name);
    if ($name === '') {
        return $from;
    }
    $encodedName = '=?UTF-8?B?' . base64_encode($name) . '?=';
    return $encodedName . ' <' . $from . '>';
}

function send_mail(string $email, string $subject, string $body): bool {
    $from = get_setting('email_from', 'no-reply@example.com');
    $fromName = get_setting('email_from_name', '思源笔记分享');
    if (smtp_enabled()) {
        return send_smtp_mail($email, $subject, $body, $from, $fromName);
    }
    $headers = [];
    $headers[] = 'From: ' . build_from_header($from, $fromName);
    $headers[] = 'Content-Type: text/plain; charset=UTF-8';
    return mail($email, $subject, $body, implode("\r\n", $headers));
}

function send_smtp_mail(string $email, string $subject, string $body, string $from, string $fromName): bool {
    $host = trim((string)get_setting('smtp_host', ''));
    if ($host === '') {
        return false;
    }
    $port = (int)get_setting('smtp_port', '587');
    $secure = strtolower(trim((string)get_setting('smtp_secure', 'tls')));
    $user = (string)get_setting('smtp_user', '');
    $pass = (string)get_setting('smtp_pass', '');
    $GLOBALS['smtp_last_error'] = '';
    try {
        require_once __DIR__ . '/vendor/PHPMailer/PHPMailer.php';
        require_once __DIR__ . '/vendor/PHPMailer/SMTP.php';
        require_once __DIR__ . '/vendor/PHPMailer/Exception.php';
        $mailer = new PHPMailer\PHPMailer\PHPMailer(true);
        $mailer->CharSet = 'UTF-8';
        $mailer->isSMTP();
        $mailer->Host = $host;
        $mailer->Port = $port > 0 ? $port : 587;
        $mailer->SMTPAuth = $user !== '';
        if ($secure === 'ssl') {
            $mailer->SMTPSecure = PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_SMTPS;
        } elseif ($secure === 'tls') {
            $mailer->SMTPSecure = PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_STARTTLS;
        } else {
            $mailer->SMTPAutoTLS = false;
        }
        if ($user !== '') {
            $mailer->Username = $user;
            $mailer->Password = $pass;
        }
        $resolvedFrom = $from;
        if ($user !== '' && strcasecmp($from, $user) !== 0) {
            $resolvedFrom = $user;
            $mailer->addReplyTo($from, $fromName ?: $from);
        }
        $mailer->setFrom($resolvedFrom, $fromName ?: $resolvedFrom);
        if ($user !== '') {
            $mailer->Sender = $user;
        }
        $mailer->addAddress($email);
        $mailer->Subject = $subject;
        $mailer->Body = $body;
        $mailer->isHTML(false);
        if (!$mailer->send()) {
            $GLOBALS['smtp_last_error'] = $mailer->ErrorInfo;
            return false;
        }
        return true;
    } catch (Throwable $e) {
        $GLOBALS['smtp_last_error'] = $e->getMessage();
        return false;
    }
}

function send_email_code(string $email, string $code): bool {
    $subject = get_setting('email_subject', '邮箱验证码');
    $body = "您的邮箱验证码为：{$code}\n有效期 10 分钟，请勿泄露。";
    return send_mail($email, $subject, $body);
}

function send_reset_code(string $email, string $code): bool {
    $subject = get_setting('email_reset_subject', '重置密码验证码');
    $body = "您的密码重置验证码为：{$code}\n有效期 10 分钟，请勿泄露。";
    return send_mail($email, $subject, $body);
}

function send_comment_notification(array $share, array $comment, string $recipientEmail, bool $isReply): void {
    $recipientEmail = trim($recipientEmail);
    if ($recipientEmail === '') {
        return;
    }
    $slug = (string)($share['slug'] ?? '');
    if ($slug === '') {
        return;
    }
    $shareTitle = (string)($share['title'] ?? $slug);
    $commentEmail = (string)($comment['email'] ?? '');
    $commentEmailMasked = $commentEmail !== '' ? mask_email($commentEmail) : '';
    $commentContent = (string)($comment['content'] ?? '');
    $commentId = (int)($comment['id'] ?? 0);
    $url = share_url($slug);
    $anchor = $commentId > 0 ? '#comment-' . $commentId : '#comments';
    $subject = $isReply ? '评论收到回复' : '分享收到新评论';
    $body = $isReply
        ? "您在分享《{$shareTitle}》下的评论收到回复：\n"
        : "您的分享《{$shareTitle}》收到新评论：\n";
    if ($commentEmailMasked !== '') {
        $body .= "评论邮箱：{$commentEmailMasked}\n";
    }
    if ($commentContent !== '') {
        $body .= "评论内容：\n{$commentContent}\n";
    }
    $body .= "查看评论：{$url}{$anchor}\n";
    send_mail($recipientEmail, $subject, $body);
}

function create_email_code(string $email, string $ip): string {
    $pdo = db();
    $code = (string)random_int(100000, 999999);
    $hash = password_hash($code, PASSWORD_DEFAULT);
    $expiresAt = date('Y-m-d H:i:s', time() + 600);
    $stmt = $pdo->prepare('INSERT INTO email_codes (email, code_hash, expires_at, created_at, ip)
        VALUES (:email, :code_hash, :expires_at, :created_at, :ip)');
    $stmt->execute([
        ':email' => $email,
        ':code_hash' => $hash,
        ':expires_at' => $expiresAt,
        ':created_at' => now(),
        ':ip' => $ip,
    ]);
    return $code;
}

function verify_email_code(string $email, string $code): bool {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM email_codes WHERE email = :email AND used_at IS NULL AND expires_at > :now ORDER BY id DESC LIMIT 1');
    $stmt->execute([
        ':email' => $email,
        ':now' => now(),
    ]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return false;
    }
    if (!password_verify($code, $row['code_hash'])) {
        return false;
    }
    $update = $pdo->prepare('UPDATE email_codes SET used_at = :used_at WHERE id = :id');
    $update->execute([':used_at' => now(), ':id' => $row['id']]);
    return true;
}

function create_reset_code(int $userId, string $email, string $ip): string {
    $pdo = db();
    $code = (string)random_int(100000, 999999);
    $hash = password_hash($code, PASSWORD_DEFAULT);
    $expiresAt = date('Y-m-d H:i:s', time() + 600);
    $stmt = $pdo->prepare('INSERT INTO password_resets (user_id, email, code_hash, expires_at, created_at, ip)
        VALUES (:user_id, :email, :code_hash, :expires_at, :created_at, :ip)');
    $stmt->execute([
        ':user_id' => $userId,
        ':email' => $email,
        ':code_hash' => $hash,
        ':expires_at' => $expiresAt,
        ':created_at' => now(),
        ':ip' => $ip,
    ]);
    return $code;
}

function verify_reset_code(int $userId, string $email, string $code): bool {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM password_resets WHERE user_id = :user_id AND email = :email AND used_at IS NULL AND expires_at > :now ORDER BY id DESC LIMIT 1');
    $stmt->execute([
        ':user_id' => $userId,
        ':email' => $email,
        ':now' => now(),
    ]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return false;
    }
    if (!password_verify($code, $row['code_hash'])) {
        return false;
    }
    $update = $pdo->prepare('UPDATE password_resets SET used_at = :used_at WHERE id = :id');
    $update->execute([':used_at' => now(), ':id' => $row['id']]);
    return true;
}

function current_user(): ?array {
    if (empty($_SESSION['user_id']) || empty($_SESSION['password_hash'])) {
        return null;
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM users WHERE id = :id');
    $stmt->execute([':id' => $_SESSION['user_id']]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return null;
    }
    $sessionHash = (string)($_SESSION['password_hash'] ?? '');
    if ($sessionHash === '' || !hash_equals((string)$row['password_hash'], $sessionHash)) {
        $_SESSION = [];
        session_destroy();
        return null;
    }
    return $row;
}

function touch_user_activity(array $user): void {
    $userId = (int)($user['id'] ?? 0);
    if ($userId <= 0) {
        return;
    }
    $last = trim((string)($user['last_active_at'] ?? ''));
    if ($last !== '') {
        $lastTs = strtotime($last);
        if ($lastTs && (time() - $lastTs) < 600) {
            return;
        }
    }
    if (!empty($_SESSION['last_active_touch'])) {
        $sessionTs = (int)$_SESSION['last_active_touch'];
        if ($sessionTs > 0 && (time() - $sessionTs) < 600) {
            return;
        }
    }
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE users SET last_active_at = :ts WHERE id = :id');
    $stmt->execute([
        ':ts' => now(),
        ':id' => $userId,
    ]);
    $_SESSION['last_active_touch'] = time();
}

function require_login(): array {
    $user = current_user();
    if (!$user) {
        redirect('/login');
    }
    if ((int)$user['disabled'] === 1) {
        session_destroy();
        redirect('/login');
    }
    touch_user_activity($user);
    return $user;
}

function require_admin(): array {
    $user = require_login();
    if ($user['role'] !== 'admin') {
        http_response_code(403);
        echo 'Forbidden';
        exit;
    }
    return $user;
}

function api_user_from_key(string $key): ?array {
    if ($key === '') {
        return null;
    }
    $prefix = substr($key, 0, 8);
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM users WHERE api_key_prefix = :prefix AND disabled = 0');
    $stmt->execute([':prefix' => $prefix]);
    $users = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($users as $user) {
        if (!empty($user['api_key_hash']) && password_verify($key, $user['api_key_hash'])) {
            return $user;
        }
    }
    return null;
}

function require_api_user(): array {
    $key = $_SERVER['HTTP_X_API_KEY'] ?? '';
    if (!$key) {
        $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
        if (stripos($auth, 'bearer ') === 0) {
            $key = trim(substr($auth, 7));
        }
    }
    $user = api_user_from_key($key);
    if (!$user) {
        api_response(401, null, 'API Key 无效或已失效，请前往控制台重新生成');
    }
    touch_user_activity($user);
    return $user;
}

function api_response(int $status, $data, string $msg = ''): void {
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Headers: Content-Type, X-Api-Key, Authorization');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    http_response_code($status);
    echo json_encode([
        'code' => $status === 200 ? 0 : $status,
        'msg' => $msg,
        'data' => $data,
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

function parse_json_body(): array {
    $raw = file_get_contents('php://input');
    if (!$raw) {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function share_url(string $slug): string {
    return base_url() . '/s/' . rawurlencode($slug);
}

function find_share_by_slug(string $slug): ?array {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM shares WHERE slug = :slug AND deleted_at IS NULL LIMIT 1');
    $stmt->execute([':slug' => $slug]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function get_active_announcements(): array {
    $pdo = db();
    $stmt = $pdo->query('SELECT * FROM announcements WHERE active = 1 ORDER BY created_at DESC');
    return $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
}

function render_announcements_html(): string {
    $items = get_active_announcements();
    if (empty($items)) {
        return '';
    }
    $html = '<div class="card"><h2>公告</h2><div class="list">';
    foreach ($items as $item) {
        $title = htmlspecialchars($item['title']);
        $content = nl2br((string)$item['content']);
        $html .= '<div class="list-item"><strong>' . $title . '</strong><div class="muted">' . $content . '</div></div>';
    }
    $html .= '</div></div>';
    return $html;
}

function should_show_announcement_modal(array $items): bool {
    if (empty($items)) {
        return false;
    }
    $today = date('Y-m-d');
    $hidden = $_COOKIE['announcement_hide_date'] ?? '';
    return $hidden !== $today;
}

function render_announcement_modal(array $items): string {
    if (empty($items)) {
        return '';
    }
    $html = '<div class="modal announcement-modal" data-announcement-modal="1">';
    $html .= '<div class="modal-backdrop" data-modal-close="1"></div>';
    $html .= '<div class="modal-card">';
    $html .= '<div class="modal-header">最新公告</div>';
    $html .= '<div class="modal-body">';
    foreach ($items as $item) {
        $title = htmlspecialchars($item['title']);
        $content = nl2br((string)$item['content']);
        $html .= '<div class="announcement-item"><div class="announcement-title">' . $title . '</div><div class="announcement-content">' . $content . '</div></div>';
    }
    $html .= '</div>';
    $html .= '<div class="modal-footer">';
    $html .= '<label class="checkbox"><input type="checkbox" data-announcement-hide> 今天不再弹出</label>';
    $html .= '<button class="button primary" data-modal-close="1">知道了</button>';
    $html .= '</div></div></div>';
    return $html;
}

function build_scan_item_link(array $meta): string {
    $itemType = (string)($meta['item_type'] ?? 'doc');
    $slug = (string)($meta['slug'] ?? '');
    if ($itemType === 'comment') {
        $commentId = (int)($meta['comment_id'] ?? 0);
        $commentEmail = (string)($meta['comment_email'] ?? '');
        $commentCreatedAt = (string)($meta['comment_created_at'] ?? '');
        $commentContent = (string)($meta['comment_content'] ?? '');
        $shareTitle = (string)($meta['share_title'] ?? '');
        $label = $commentId > 0 ? '评论#' . $commentId : '评论';
        $attrs = ' data-admin-comment-edit="1"'
            . ' data-admin-comment-id="' . $commentId . '"'
            . ' data-admin-comment-email="' . htmlspecialchars($commentEmail, ENT_QUOTES) . '"'
            . ' data-admin-comment-created="' . htmlspecialchars(format_share_datetime($commentCreatedAt), ENT_QUOTES) . '"'
            . ' data-admin-comment-share="' . htmlspecialchars($shareTitle, ENT_QUOTES) . '"'
            . ' data-admin-comment-content="' . htmlspecialchars($commentContent, ENT_QUOTES) . '"';
        return '<button type="button" class="scan-comment-link"' . $attrs . '>' . htmlspecialchars($label) . '</button>';
    }
    $docId = (string)($meta['doc_id'] ?? '');
    $docTitle = (string)($meta['doc_title'] ?? '');
    $docLabel = trim($docTitle) !== '' ? $docTitle : $docId;
    $docLabel = $docLabel !== '' ? '文档：' . $docLabel : '文档';
    $docUrl = '';
    if ($slug !== '') {
        $docUrl = $docId !== '' ? base_url() . build_share_redirect_path($slug, $docId, '') : share_url($slug);
    }
    if ($docUrl !== '') {
        return '<a class="scan-comment-link" href="' . htmlspecialchars($docUrl) . '" target="_blank">' . htmlspecialchars($docLabel) . '</a>';
    }
    return htmlspecialchars($docLabel);
}

function build_scan_log_entry(array $meta, ?array $hit): string {
    $prefix = $hit ? '命中违禁词 [' . htmlspecialchars((string)$hit['word']) . ']：' : '未命中：';
    $parts = [];
    $shareTitle = trim((string)($meta['share_title'] ?? ''));
    if ($shareTitle !== '') {
        $parts[] = htmlspecialchars($shareTitle);
    }
    $parts[] = build_scan_item_link($meta);
    $username = trim((string)($meta['username'] ?? ''));
    if ($username !== '') {
        $parts[] = htmlspecialchars($username);
    }
    if ((string)($meta['item_type'] ?? '') === 'comment') {
        $commentEmail = trim((string)($meta['comment_email'] ?? ''));
        if ($commentEmail !== '') {
            $parts[] = '邮箱：' . htmlspecialchars($commentEmail);
        }
        $commentCreatedAt = (string)($meta['comment_created_at'] ?? '');
        if ($commentCreatedAt !== '') {
            $parts[] = '时间：' . htmlspecialchars(format_share_datetime($commentCreatedAt));
        }
    } else {
        $hpath = trim((string)($meta['hpath'] ?? ''));
        if ($hpath !== '') {
            $parts[] = '路径：' . htmlspecialchars($hpath);
        }
    }
    return $prefix . implode(' / ', $parts);
}

function scan_banned_shares(array $words): array {
    if (empty($words)) {
        return [];
    }
    $pdo = db();
    $sql = 'SELECT shares.id AS share_id, shares.title AS share_title, shares.type, shares.slug, shares.user_id,
        users.username, share_docs.doc_id, share_docs.title AS doc_title, share_docs.hpath, share_docs.markdown
        FROM share_docs
        JOIN shares ON share_docs.share_id = shares.id
        JOIN users ON shares.user_id = users.id
        WHERE shares.deleted_at IS NULL
        ORDER BY shares.updated_at DESC';
    $stmt = $pdo->query($sql);
    $results = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $markdown = (string)($row['markdown'] ?? '');
        if ($markdown === '') {
            continue;
        }
        $hit = find_banned_word($markdown, $words);
        if (!$hit) {
            continue;
        }
        $results[] = [
            'item_type' => 'doc',
            'share_id' => (int)$row['share_id'],
            'share_title' => $row['share_title'],
            'share_type' => $row['type'],
            'slug' => $row['slug'],
            'user_id' => (int)$row['user_id'],
            'username' => $row['username'],
            'doc_id' => $row['doc_id'],
            'doc_title' => $row['doc_title'],
            'hpath' => $row['hpath'],
            'word' => $hit['word'],
            'snippet' => extract_snippet($markdown, $hit['word']),
        ];
    }
    $commentSql = 'SELECT share_comments.id AS comment_id, share_comments.email AS comment_email, share_comments.content AS comment_content,
        share_comments.created_at AS comment_created_at, shares.id AS share_id, shares.title AS share_title, shares.type, shares.slug,
        shares.user_id, users.username
        FROM share_comments
        JOIN shares ON share_comments.share_id = shares.id
        JOIN users ON shares.user_id = users.id
        WHERE shares.deleted_at IS NULL
        ORDER BY share_comments.created_at DESC, share_comments.id DESC';
    $commentStmt = $pdo->query($commentSql);
    foreach ($commentStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $commentContent = (string)($row['comment_content'] ?? '');
        if ($commentContent === '') {
            continue;
        }
        $hit = find_banned_word($commentContent, $words);
        if (!$hit) {
            continue;
        }
        $results[] = [
            'item_type' => 'comment',
            'share_id' => (int)$row['share_id'],
            'share_title' => $row['share_title'],
            'share_type' => $row['type'],
            'slug' => $row['slug'],
            'user_id' => (int)$row['user_id'],
            'username' => $row['username'],
            'doc_id' => null,
            'doc_title' => null,
            'hpath' => null,
            'comment_id' => (int)$row['comment_id'],
            'comment_email' => $row['comment_email'],
            'comment_created_at' => $row['comment_created_at'],
            'comment_content' => $commentContent,
            'word' => $hit['word'],
            'snippet' => extract_snippet($commentContent, $hit['word']),
        ];
    }
    return $results;
}

function count_scannable_share_docs(): int {
    $pdo = db();
    $stmt = $pdo->query('SELECT COUNT(*) FROM share_docs JOIN shares ON share_docs.share_id = shares.id WHERE shares.deleted_at IS NULL');
    return $stmt ? (int)$stmt->fetchColumn() : 0;
}

function count_scannable_comments(): int {
    $pdo = db();
    $stmt = $pdo->query('SELECT COUNT(*) FROM share_comments JOIN shares ON share_comments.share_id = shares.id WHERE shares.deleted_at IS NULL');
    return $stmt ? (int)$stmt->fetchColumn() : 0;
}

function count_scannable_docs(): int {
    return count_scannable_share_docs() + count_scannable_comments();
}

function scan_banned_shares_batch(array $words, int $offset, int $limit): array {
    if (empty($words)) {
        return ['hits' => [], 'logs' => [], 'count' => 0];
    }
    $hits = [];
    $logs = [];
    $count = 0;
    $docCount = count_scannable_share_docs();
    $remaining = $limit;
    $docOffset = $offset;
    if ($docOffset < $docCount) {
        $docLimit = min($remaining, $docCount - $docOffset);
        $pdo = db();
        $sql = 'SELECT shares.id AS share_id, shares.title AS share_title, shares.type, shares.slug, shares.user_id,
            users.username, share_docs.doc_id, share_docs.title AS doc_title, share_docs.hpath, share_docs.markdown
            FROM share_docs
            JOIN shares ON share_docs.share_id = shares.id
            JOIN users ON shares.user_id = users.id
            WHERE shares.deleted_at IS NULL
            ORDER BY share_docs.id ASC
            LIMIT :limit OFFSET :offset';
        $stmt = $pdo->prepare($sql);
        $stmt->bindValue(':limit', $docLimit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $docOffset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $count += count($rows);
        foreach ($rows as $row) {
            $markdown = (string)($row['markdown'] ?? '');
            $meta = [
                'item_type' => 'doc',
                'share_title' => $row['share_title'],
                'slug' => $row['slug'],
                'doc_id' => $row['doc_id'],
                'doc_title' => $row['doc_title'],
                'hpath' => $row['hpath'],
                'username' => $row['username'],
            ];
            $hit = $markdown !== '' ? find_banned_word($markdown, $words) : null;
            if ($hit) {
                $hits[] = [
                    'item_type' => 'doc',
                    'share_id' => (int)$row['share_id'],
                    'share_title' => $row['share_title'],
                    'share_type' => $row['type'],
                    'slug' => $row['slug'],
                    'user_id' => (int)$row['user_id'],
                    'username' => $row['username'],
                    'doc_id' => $row['doc_id'],
                    'doc_title' => $row['doc_title'],
                    'hpath' => $row['hpath'],
                    'word' => $hit['word'],
                    'snippet' => extract_snippet($markdown, $hit['word']),
                ];
                $logs[] = build_scan_log_entry($meta, $hit);
            } else {
                $logs[] = build_scan_log_entry($meta, null);
            }
        }
        $remaining -= count($rows);
    }
    if ($remaining > 0) {
        $commentOffset = max(0, $offset - $docCount);
        $pdo = $pdo ?? db();
        $sql = 'SELECT share_comments.id AS comment_id, share_comments.email AS comment_email, share_comments.content AS comment_content,
            share_comments.created_at AS comment_created_at, shares.id AS share_id, shares.title AS share_title, shares.type, shares.slug,
            shares.user_id, users.username
            FROM share_comments
            JOIN shares ON share_comments.share_id = shares.id
            JOIN users ON shares.user_id = users.id
            WHERE shares.deleted_at IS NULL
            ORDER BY share_comments.id ASC
            LIMIT :limit OFFSET :offset';
        $stmt = $pdo->prepare($sql);
        $stmt->bindValue(':limit', $remaining, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $commentOffset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $count += count($rows);
        foreach ($rows as $row) {
            $commentContent = (string)($row['comment_content'] ?? '');
            $commentId = (int)($row['comment_id'] ?? 0);
            $commentEmail = trim((string)($row['comment_email'] ?? ''));
            $meta = [
                'item_type' => 'comment',
                'share_title' => $row['share_title'],
                'slug' => $row['slug'],
                'username' => $row['username'],
                'comment_id' => $commentId,
                'comment_email' => $commentEmail,
                'comment_created_at' => $row['comment_created_at'],
                'comment_content' => $commentContent,
            ];
            $hit = $commentContent !== '' ? find_banned_word($commentContent, $words) : null;
            if ($hit) {
                $hits[] = [
                    'item_type' => 'comment',
                    'share_id' => (int)$row['share_id'],
                    'share_title' => $row['share_title'],
                    'share_type' => $row['type'],
                    'slug' => $row['slug'],
                    'user_id' => (int)$row['user_id'],
                    'username' => $row['username'],
                    'doc_id' => null,
                    'doc_title' => null,
                    'hpath' => null,
                    'comment_id' => $commentId,
                    'comment_email' => $commentEmail,
                    'comment_created_at' => $row['comment_created_at'],
                    'comment_content' => $commentContent,
                    'word' => $hit['word'],
                    'snippet' => extract_snippet($commentContent, $hit['word']),
                ];
                $logs[] = build_scan_log_entry($meta, $hit);
            } else {
                $logs[] = build_scan_log_entry($meta, null);
            }
        }
    }
    return ['hits' => $hits, 'logs' => $logs, 'count' => $count];
}

function ensure_dir(string $path): void {
    if (!is_dir($path)) {
        mkdir($path, 0775, true);
    }
}

function remove_dir(string $dir): void {
    if (!is_dir($dir)) {
        return;
    }
    $items = scandir($dir);
    if ($items === false) {
        return;
    }
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }
        $path = $dir . DIRECTORY_SEPARATOR . $item;
        if (is_dir($path)) {
            remove_dir($path);
        } else {
            @unlink($path);
        }
    }
    @rmdir($dir);
}

function move_dir(string $source, string $target): bool {
    if (!is_dir($source)) {
        return false;
    }
    if (is_dir($target)) {
        remove_dir($target);
    }
    ensure_dir(dirname($target));
    if (@rename($source, $target)) {
        return true;
    }
    ensure_dir($target);
    $items = scandir($source);
    if ($items === false) {
        return false;
    }
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }
        $src = $source . DIRECTORY_SEPARATOR . $item;
        $dst = $target . DIRECTORY_SEPARATOR . $item;
        if (is_dir($src)) {
            move_dir($src, $dst);
        } else {
            @copy($src, $dst);
        }
    }
    remove_dir($source);
    return true;
}

function chunk_cleanup_settings(): array {
    global $config;
    $ttl = (int)($config['chunk_ttl_seconds'] ?? 7200);
    $prob = (float)($config['chunk_cleanup_probability'] ?? 0.05);
    $limit = (int)($config['chunk_cleanup_limit'] ?? 20);
    if ($ttl < 60) {
        $ttl = 60;
    }
    if ($prob < 0) {
        $prob = 0;
    } elseif ($prob > 1) {
        $prob = 1;
    }
    if ($limit < 1) {
        $limit = 20;
    }
    return [$ttl, $prob, $limit];
}

function latest_mtime(string $path): int {
    if (is_file($path)) {
        return (int)(@filemtime($path) ?: 0);
    }
    if (!is_dir($path)) {
        return 0;
    }
    $items = scandir($path);
    if ($items === false) {
        return (int)(@filemtime($path) ?: 0);
    }
    $latest = 0;
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }
        $child = $path . DIRECTORY_SEPARATOR . $item;
        $mtime = latest_mtime($child);
        if ($mtime > $latest) {
            $latest = $mtime;
        }
    }
    if ($latest <= 0) {
        $latest = (int)(@filemtime($path) ?: 0);
    }
    return $latest;
}

function cleanup_stale_dirs(string $base, int $ttl, int $limit): void {
    if (!is_dir($base)) {
        return;
    }
    $dirs = scandir($base);
    if ($dirs === false) {
        return;
    }
    $now = time();
    $deleted = 0;
    foreach ($dirs as $dir) {
        if ($dir === '.' || $dir === '..') {
            continue;
        }
        $path = $base . DIRECTORY_SEPARATOR . $dir;
        if (!is_dir($path)) {
            continue;
        }
        $mtime = latest_mtime($path);
        if ($mtime <= 0 || ($now - $mtime) < $ttl) {
            continue;
        }
        remove_dir($path);
        $deleted += 1;
        if ($deleted >= $limit) {
            break;
        }
    }
}

function maybe_cleanup_chunks(): void {
    global $config;
    [$ttl, $prob, $limit] = chunk_cleanup_settings();
    if ($prob <= 0 || $ttl <= 0 || $limit <= 0) {
        return;
    }
    $rand = mt_rand() / mt_getrandmax();
    if ($rand > $prob) {
        return;
    }
    cleanup_stale_dirs($config['uploads_dir'] . '/chunks', $ttl, $limit);
    cleanup_stale_dirs($config['uploads_dir'] . '/staging', $ttl, $limit);
}

function list_stale_chunks(int $ttl): array {
    global $config;
    $base = $config['uploads_dir'] . '/chunks';
    if (!is_dir($base)) {
        return [];
    }
    $dirs = scandir($base);
    if ($dirs === false) {
        return [];
    }
    $now = time();
    $rows = [];
    foreach ($dirs as $dir) {
        if ($dir === '.' || $dir === '..') {
            continue;
        }
        $path = $base . DIRECTORY_SEPARATOR . $dir;
        if (!is_dir($path)) {
            continue;
        }
        $mtime = latest_mtime($path);
        if ($mtime <= 0) {
            continue;
        }
        $age = $now - $mtime;
        if ($age < $ttl) {
            continue;
        }
        $rows[] = [
            'id' => $dir,
            'mtime' => $mtime,
            'age' => $age,
        ];
    }
    usort($rows, function ($a, $b) {
        return $a['mtime'] <=> $b['mtime'];
    });
    return $rows;
}

function sanitize_asset_path(string $path): string {
    $path = str_replace('\\', '/', $path);
    $path = ltrim($path, '/');
    if ($path === '' || strpos($path, '..') !== false) {
        return '';
    }
    return $path;
}

function sanitize_upload_id(string $uploadId): string {
    $uploadId = trim($uploadId);
    if ($uploadId === '' || !preg_match('/^[a-f0-9]{32}$/', $uploadId)) {
        return '';
    }
    return $uploadId;
}

function collect_asset_entries(array $files, array $paths, array $docIds): array {
    $entries = [];
    $seen = [];
    if (empty($files['name'])) {
        return $entries;
    }
    $count = is_array($files['name']) ? count($files['name']) : 0;
    for ($i = 0; $i < $count; $i++) {
        $tmp = $files['tmp_name'][$i] ?? '';
        if ($tmp === '') {
            continue;
        }
        $assetPath = $paths[$i] ?? ($files['name'][$i] ?? '');
        $assetPath = sanitize_asset_path((string)$assetPath);
        if ($assetPath === '' || isset($seen[$assetPath])) {
            continue;
        }
        $seen[$assetPath] = true;
        $entries[] = [
            'tmp' => $tmp,
            'path' => $assetPath,
            'docId' => $docIds[$i] ?? null,
            'size' => (int)($files['size'][$i] ?? 0),
        ];
    }
    return $entries;
}

function allocate_share_id(PDO $pdo): int {
    $stmt = $pdo->query('SELECT share_id FROM recycled_share_ids ORDER BY share_id ASC LIMIT 1');
    $shareId = (int)($stmt ? $stmt->fetchColumn() : 0);
    if ($shareId > 0) {
        $del = $pdo->prepare('DELETE FROM recycled_share_ids WHERE share_id = :share_id');
        $del->execute([':share_id' => $shareId]);
        return $shareId;
    }
    return 0;
}

function recycle_share_id(int $shareId): void {
    if ($shareId <= 0) {
        return;
    }
    $pdo = db();
    $stmt = $pdo->prepare('INSERT OR IGNORE INTO recycled_share_ids (share_id, created_at) VALUES (:share_id, :created_at)');
    $stmt->execute([
        ':share_id' => $shareId,
        ':created_at' => now(),
    ]);
}

function purge_share_assets(int $shareId, bool $keepCommentFiles = false): void {
    global $config;
    $pdo = db();
    $dir = $config['uploads_dir'] . '/shares/' . $shareId;
    remove_dir($dir);
    if (!$keepCommentFiles) {
        $commentDir = $config['uploads_dir'] . '/' . trim(comment_asset_prefix(), '/') . '/' . $shareId;
        remove_dir($commentDir);
        $stmt = $pdo->prepare('DELETE FROM share_assets WHERE share_id = :share_id');
        $stmt->execute([':share_id' => $shareId]);
        return;
    }
    $stmt = $pdo->prepare('DELETE FROM share_assets WHERE share_id = :share_id AND asset_path NOT LIKE :prefix');
    $stmt->execute([
        ':share_id' => $shareId,
        ':prefix' => comment_asset_prefix() . '%',
    ]);
}

function hard_delete_share(int $shareId): ?int {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT user_id FROM shares WHERE id = :id');
    $stmt->execute([':id' => $shareId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return null;
    }
    $userId = (int)$row['user_id'];
    purge_share_assets($shareId);
    purge_share_chunks($shareId);
    purge_share_access_logs($shareId);
    $uploadIds = $pdo->prepare('SELECT upload_id FROM share_uploads WHERE share_id = :share_id');
    $uploadIds->execute([':share_id' => $shareId]);
    $uploadList = array_values(array_filter($uploadIds->fetchAll(PDO::FETCH_COLUMN)));
    if ($uploadList) {
        $placeholders = implode(',', array_fill(0, count($uploadList), '?'));
        $stmt = $pdo->prepare('DELETE FROM share_upload_docs WHERE upload_id IN (' . $placeholders . ')');
        $stmt->execute($uploadList);
    }
    $pdo->prepare('DELETE FROM share_uploads WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
    $pdo->prepare('DELETE FROM share_comments WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
    $pdo->prepare('DELETE FROM share_reports WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
    $pdo->prepare('DELETE FROM share_visitors WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
    $pdo->prepare('DELETE FROM share_docs WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
    $pdo->prepare('DELETE FROM shares WHERE id = :id')->execute([':id' => $shareId]);
    recycle_share_id($shareId);
    recalculate_user_storage($userId);
    return $userId;
}

function delete_user_account(int $userId): bool {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT email, role FROM users WHERE id = :id');
    $stmt->execute([':id' => $userId]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$user) {
        return false;
    }
    if (($user['role'] ?? '') === 'admin') {
        return false;
    }
    $shareStmt = $pdo->prepare('SELECT id FROM shares WHERE user_id = :user_id');
    $shareStmt->execute([':user_id' => $userId]);
    $shareIds = $shareStmt->fetchAll(PDO::FETCH_COLUMN);
    foreach ($shareIds as $shareId) {
        hard_delete_share((int)$shareId);
    }
    $pdo->prepare('DELETE FROM password_resets WHERE user_id = :user_id')->execute([':user_id' => $userId]);
    $pdo->prepare('UPDATE announcements SET created_by = NULL WHERE created_by = :user_id')->execute([':user_id' => $userId]);
    $email = trim((string)($user['email'] ?? ''));
    if ($email !== '') {
        $pdo->prepare('DELETE FROM email_codes WHERE email = :email')->execute([':email' => $email]);
    }
    $pdo->prepare('DELETE FROM users WHERE id = :id')->execute([':id' => $userId]);
    return true;
}

function reset_database(): void {
    global $config;
    $pdo = db();
    $pdo->exec('PRAGMA foreign_keys = OFF;');
    $tables = $pdo
        ->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        ->fetchAll(PDO::FETCH_COLUMN);
    foreach ($tables as $table) {
        if (!$table) {
            continue;
        }
        $pdo->exec('DELETE FROM "' . $table . '"');
    }
    $pdo->exec('DELETE FROM sqlite_sequence');
    $pdo->exec('PRAGMA foreign_keys = ON;');
    seed_default_settings($pdo);
    seed_default_admin($pdo);
    remove_dir($config['uploads_dir']);
    ensure_dir($config['uploads_dir']);
    ensure_dir($config['uploads_dir'] . '/shares');
    ensure_dir($config['uploads_dir'] . '/' . trim(comment_asset_prefix(), '/'));
}

function handle_asset_uploads(int $shareId, array $entries): int {
    global $config;
    if (empty($entries)) {
        return 0;
    }
    ensure_dir($config['uploads_dir']);
    $pdo = db();
    $total = 0;
    foreach ($entries as $entry) {
        $tmp = $entry['tmp'];
        $assetPath = (string)($entry['path'] ?? '');
        $assetPath = trim(str_replace('\\', '/', $assetPath));
        $assetPath = ltrim($assetPath, '/');
        if ($assetPath === '' || substr($assetPath, -1) === '/') {
            continue;
        }
        if (!is_uploaded_file($tmp)) {
            continue;
        }
        $docId = $entry['docId'] ?? null;
        $size = (int)($entry['size'] ?? 0);
        $targetDir = $config['uploads_dir'] . '/shares/' . $shareId . '/' . dirname($assetPath);
        ensure_dir($targetDir);
        $targetFile = $config['uploads_dir'] . '/shares/' . $shareId . '/' . $assetPath;
        if (!move_uploaded_file($tmp, $targetFile)) {
            continue;
        }
        $actualSize = $size;
        if ($actualSize <= 0 && is_file($targetFile)) {
            $actualSize = (int)filesize($targetFile);
        }
        $total += $actualSize;
        $stmt = $pdo->prepare('INSERT OR REPLACE INTO share_assets (share_id, doc_id, asset_path, file_path, size_bytes, created_at)
            VALUES (:share_id, :doc_id, :asset_path, :file_path, :size_bytes, :created_at)');
        $stmt->execute([
            ':share_id' => $shareId,
            ':doc_id' => $docId,
            ':asset_path' => $assetPath,
            ':file_path' => 'shares/' . $shareId . '/' . $assetPath,
            ':size_bytes' => $actualSize,
            ':created_at' => now(),
        ]);
    }
    return $total;
}

function normalize_asset_manifest($rawAssets): array {
    $assets = [];
    $seen = [];
    if (!is_array($rawAssets)) {
        return $assets;
    }
    foreach ($rawAssets as $item) {
        if (!is_array($item)) {
            continue;
        }
        $path = sanitize_asset_path((string)($item['path'] ?? ''));
        if ($path === '' || isset($seen[$path])) {
            continue;
        }
        $seen[$path] = true;
        $size = (int)($item['size'] ?? 0);
        if ($size < 0) {
            $size = 0;
        }
        $docId = isset($item['docId']) ? trim((string)($item['docId'])) : null;
        $assets[] = [
            'path' => $path,
            'size' => $size,
            'docId' => $docId,
        ];
    }
    return $assets;
}

function share_chunks_dir(int $shareId): string {
    global $config;
    return $config['uploads_dir'] . '/chunks/' . $shareId;
}

function upload_chunks_dir(string $uploadId): string {
    global $config;
    return $config['uploads_dir'] . '/chunks/' . $uploadId;
}

function upload_staging_dir(string $uploadId): string {
    global $config;
    return $config['uploads_dir'] . '/staging/' . $uploadId;
}

function purge_upload_session_files(string $uploadId): void {
    remove_dir(upload_chunks_dir($uploadId));
    remove_dir(upload_staging_dir($uploadId));
}

function generate_upload_id(): string {
    return bin2hex(random_bytes(16));
}

function purge_share_chunks(int $shareId): void {
    $dir = share_chunks_dir($shareId);
    remove_dir($dir);
}

function recalculate_share_size(int $shareId): int {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM share_docs WHERE share_id = :share_id');
    $stmt->execute([':share_id' => $shareId]);
    $docSize = (int)$stmt->fetchColumn();
    $stmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM share_assets WHERE share_id = :share_id');
    $stmt->execute([':share_id' => $shareId]);
    $assetSize = (int)$stmt->fetchColumn();
    $commentSize = share_comment_size($shareId);
    $total = $docSize + $assetSize + $commentSize;
    $stmt = $pdo->prepare('UPDATE shares SET size_bytes = :size_bytes, updated_at = :updated_at WHERE id = :id');
    $stmt->execute([
        ':size_bytes' => $total,
        ':updated_at' => now(),
        ':id' => $shareId,
    ]);
    return $total;
}

function handle_instance_heartbeat(): void {
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        api_response(200, ['ok' => true], '');
    }
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        api_response(405, null, 'Method Not Allowed');
    }
    $payload = parse_json_body();
    $instanceId = trim((string)($payload['instance_id'] ?? ''));
    if ($instanceId === '') {
        api_response(400, null, 'Missing instance_id');
    }
    $version = trim((string)($payload['version'] ?? ''));
    $now = now();
    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO instance_heartbeats (instance_id, first_seen, last_seen, version, ip)
        VALUES (:id, :first_seen, :last_seen, :version, :ip)
        ON CONFLICT(instance_id) DO UPDATE SET last_seen = :last_seen, version = :version, ip = :ip');
    $stmt->execute([
        ':id' => $instanceId,
        ':first_seen' => $now,
        ':last_seen' => $now,
        ':version' => $version,
        ':ip' => get_client_ip(),
    ]);
    api_response(200, ['instance_id' => $instanceId]);
}

function handle_instance_stats(): void {
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        api_response(200, ['ok' => true], '');
    }
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
        api_response(405, null, 'Method Not Allowed');
    }
    $pdo = db();
    $total = (int)$pdo->query('SELECT COUNT(*) FROM instance_heartbeats')->fetchColumn();
    $cutoff30 = date('Y-m-d H:i:s', strtotime('-30 days'));
    $cutoff7 = date('Y-m-d H:i:s', strtotime('-7 days'));
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM instance_heartbeats WHERE last_seen >= :cutoff');
    $stmt->execute([':cutoff' => $cutoff30]);
    $active30 = (int)$stmt->fetchColumn();
    $stmt->execute([':cutoff' => $cutoff7]);
    $active7 = (int)$stmt->fetchColumn();
    api_response(200, [
        'total' => $total,
        'active_30' => $active30,
        'active_7' => $active7,
        'updated_at' => now(),
    ]);
}

function handle_api(string $path): void {
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        api_response(200, null, '');
    }
    $user = require_api_user();
    $pdo = db();
    global $config;
    maybe_cleanup_chunks();

    if ($path === '/api/v1/auth/verify') {
        [$minChunk, $maxChunk] = chunk_size_limits();
        api_response(200, ['user' => [
            'id' => $user['id'],
            'username' => $user['username'],
            'role' => $user['role'],
        ], 'limits' => [
            'minChunkSize' => $minChunk,
            'maxChunkSize' => $maxChunk,
        ]]);
    }

    if ($path === '/api/v1/shares' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $stmt = $pdo->prepare('SELECT shares.*, COALESCE(doc_counts.doc_count, 0) AS doc_count
            FROM shares
            LEFT JOIN (SELECT share_id, COUNT(*) AS doc_count FROM share_docs GROUP BY share_id) doc_counts
                ON shares.id = doc_counts.share_id
            WHERE shares.user_id = :uid AND shares.deleted_at IS NULL
            ORDER BY shares.updated_at DESC');
        $stmt->execute([':uid' => $user['id']]);
        $shares = [];
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $shares[] = [
                'id' => $row['id'],
                'slug' => $row['slug'],
                'type' => $row['type'],
                'title' => $row['title'],
                'docId' => $row['doc_id'],
                'notebookId' => $row['notebook_id'],
                'updatedAt' => strtotime($row['updated_at']) * 1000,
                'createdAt' => strtotime($row['created_at']) * 1000,
                'hasPassword' => !empty($row['password_hash']),
                'expiresAt' => $row['expires_at'] ? ((int)$row['expires_at'] * 1000) : null,
                'visitorLimit' => (int)($row['visitor_limit'] ?? 0),
                'includeChildren' => ((string)($row['type'] ?? '') === 'doc') && ((int)($row['doc_count'] ?? 0) > 1),
                'path' => '/s/' . $row['slug'],
                'url' => share_url($row['slug']),
            ];
        }
        api_response(200, ['shares' => $shares]);
    }

    if ($path === '/api/v1/shares/delete') {
        $payload = parse_json_body();
        $shareId = (int)($payload['shareId'] ?? 0);
        $hardDelete = !empty($payload['hardDelete']);
        if (!$shareId) {
            api_response(400, null, '缺少分享 ID');
        }
        if ($hardDelete) {
            $check = $pdo->prepare('SELECT id FROM shares WHERE id = :id AND user_id = :uid');
            $check->execute([
                ':id' => $shareId,
                ':uid' => $user['id'],
            ]);
            if (!$check->fetchColumn()) {
                api_response(404, null, '分享不存在');
            }
            hard_delete_share($shareId);
            api_response(200, ['ok' => true, 'hard' => true]);
        }
        $stmt = $pdo->prepare('UPDATE shares SET deleted_at = :deleted_at WHERE id = :id AND user_id = :uid');
        $stmt->execute([
            ':deleted_at' => now(),
            ':id' => $shareId,
            ':uid' => $user['id'],
        ]);
        purge_share_access_logs($shareId);
        recalculate_user_storage((int)$user['id']);
        api_response(200, ['ok' => true]);
    }

    if ($path === '/api/v1/shares/access/update' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $shareId = (int)($payload['shareId'] ?? 0);
        if (!$shareId) {
            api_response(400, null, 'Missing share id');
        }
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE id = :id AND user_id = :uid AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([
            ':id' => $shareId,
            ':uid' => $user['id'],
        ]);
        $share = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$share) {
            api_response(404, null, 'Share not found');
        }
        $password = trim((string)($payload['password'] ?? ''));
        $clearPassword = !empty($payload['clearPassword']);
        $expiresAt = parse_expires_at($payload['expiresAt'] ?? null);
        $clearExpires = !empty($payload['clearExpires']);
        $visitorLimit = parse_visitor_limit($payload['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($payload['clearVisitorLimit']);

        $passwordHash = $share['password_hash'] ?? null;
        $expiresValue = isset($share['expires_at']) ? (int)$share['expires_at'] : null;
        $visitorValue = isset($share['visitor_limit']) ? (int)$share['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }

        $stmt = $pdo->prepare('UPDATE shares SET password_hash = :password_hash, expires_at = :expires_at, visitor_limit = :visitor_limit, updated_at = :updated_at WHERE id = :id AND user_id = :uid');
        $stmt->execute([
            ':password_hash' => $passwordHash,
            ':expires_at' => $expiresValue,
            ':visitor_limit' => $visitorValue,
            ':updated_at' => now(),
            ':id' => $shareId,
            ':uid' => $user['id'],
        ]);
        if ($visitorValue > 0) {
            seed_share_visitors_from_logs($shareId);
        }
        api_response(200, ['share' => [
            'id' => (int)$share['id'],
            'slug' => $share['slug'],
            'url' => share_url($share['slug']),
            'hasPassword' => !empty($passwordHash),
            'expiresAt' => $expiresValue ? ($expiresValue * 1000) : null,
            'visitorLimit' => $visitorValue,
        ]]);
    }

    if ($path === '/api/v1/shares/doc/init' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $meta = $payload['metadata'] ?? $payload;
        if (!is_array($meta)) {
            api_response(400, null, 'Invalid metadata');
        }
        $docId = trim((string)($meta['docId'] ?? ''));
        $title = trim((string)($meta['title'] ?? ''));
        $markdown = (string)($meta['markdown'] ?? '');
        $hPath = (string)($meta['hPath'] ?? '');
        $sortOrder = max(0, (int)($meta['sortOrder'] ?? 0));
        $password = trim((string)($meta['password'] ?? ''));
        $clearPassword = !empty($meta['clearPassword']);
        $expiresAt = parse_expires_at($meta['expiresAt'] ?? null);
        $clearExpires = !empty($meta['clearExpires']);
        $visitorLimit = parse_visitor_limit($meta['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($meta['clearVisitorLimit']);
        $docs = $meta['docs'] ?? [];
        $hasDocs = is_array($docs) && count($docs) > 0;
        if ($docId === '' || (!$hasDocs && $markdown === '')) {
            api_response(400, null, 'Missing document content');
        }
        $bannedWords = get_banned_words();
        if (!empty($bannedWords)) {
            if ($hasDocs) {
                foreach ($docs as $doc) {
                    $docMarkdown = (string)($doc['markdown'] ?? '');
                    if ($docMarkdown === '') {
                        continue;
                    }
                    $hit = find_banned_word($docMarkdown, $bannedWords);
                    if ($hit) {
                        $docTitle = trim((string)($doc['title'] ?? '')) ?: trim((string)($doc['docId'] ?? ''));
                        api_response(400, null, '触发违禁词：' . $hit['word'] . '（文档：' . $docTitle . '）');
                    }
                }
            } else {
                $hit = find_banned_word($markdown, $bannedWords);
                if ($hit) {
                    api_response(400, null, '触发违禁词：' . $hit['word']);
                }
            }
        }
        $slug = sanitize_slug((string)($meta['slug'] ?? ''));
        $assets = normalize_asset_manifest($payload['assets'] ?? []);
        $assetSize = 0;
        foreach ($assets as $asset) {
            $assetSize += (int)($asset['size'] ?? 0);
        }
        $docRows = [];
        $docSizeTotal = 0;
        if ($hasDocs) {
            foreach ($docs as $index => $doc) {
                $rowDocId = trim((string)($doc['docId'] ?? ''));
                $rowTitle = trim((string)($doc['title'] ?? ''));
                $rowIcon = trim((string)($doc['icon'] ?? ''));
                $rowHpath = (string)($doc['hPath'] ?? '');
                $rowMarkdown = (string)($doc['markdown'] ?? '');
                $rowSort = max(0, (int)($doc['sortOrder'] ?? $index));
                $rowParent = trim((string)($doc['parentId'] ?? ''));
                $rowSortIndex = (float)($doc['sortIndex'] ?? $index);
                if ($rowDocId === '') {
                    continue;
                }
                $size = strlen($rowMarkdown);
                $docSizeTotal += $size;
                $docRows[] = [
                    'docId' => $rowDocId,
                    'title' => $rowTitle ?: $rowDocId,
                    'icon' => $rowIcon,
                    'hPath' => $rowHpath,
                    'parentId' => $rowParent,
                    'sortIndex' => $rowSortIndex,
                    'markdown' => $rowMarkdown,
                    'sortOrder' => $rowSort,
                    'size' => $size,
                ];
            }
            if (empty($docRows)) {
                api_response(400, null, 'Missing document content');
            }
        } else {
            $docSizeTotal = strlen($markdown);
            $docIcon = trim((string)($meta['icon'] ?? ''));
            $docRows[] = [
                'docId' => $docId,
                'title' => $title ?: $docId,
                'icon' => $docIcon,
                'hPath' => $hPath,
                'parentId' => null,
                'sortIndex' => 0,
                'markdown' => $markdown,
                'sortOrder' => $sortOrder,
                'size' => $docSizeTotal,
            ];
        }
        $baseShareSize = $docSizeTotal + $assetSize;
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE user_id = :uid AND type = "doc" AND doc_id = :doc_id ORDER BY id DESC LIMIT 1');
        $stmt->execute([':uid' => $user['id'], ':doc_id' => $docId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $existingSize = $existing ? (int)($existing['size_bytes'] ?? 0) : 0;
        $commentSize = $existing ? share_comment_size((int)$existing['id']) : 0;
        $commentAssetSize = $existing ? share_comment_asset_size((int)$existing['id']) : 0;
        $newShareSize = $baseShareSize + $commentSize + $commentAssetSize;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if ($limit > 0 && ($usedWithout + $newShareSize) > $limit) {
            api_response(413, null, 'Storage limit reached');
        }

        $passwordHash = $existing['password_hash'] ?? null;
        $expiresValue = isset($existing['expires_at']) ? (int)$existing['expires_at'] : null;
        $visitorValue = isset($existing['visitor_limit']) ? (int)$existing['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }

        $finalSlug = $slug;
        if ($existing) {
            if ($finalSlug && $finalSlug !== $existing['slug']) {
                $check = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL AND id != :id');
                $check->execute([':slug' => $finalSlug, ':id' => $existing['id']]);
                if ($check->fetch()) {
                    api_response(409, null, 'Share link already exists');
                }
            }
            if (!$finalSlug) {
                $finalSlug = (string)$existing['slug'];
            }
        } else {
            if (!$finalSlug) {
                for ($i = 0; $i < 10; $i++) {
                    $finalSlug = sanitize_slug(bin2hex(random_bytes(4)));
                    $check = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL');
                    $check->execute([':slug' => $finalSlug]);
                    if (!$check->fetch()) {
                        break;
                    }
                }
            } else {
                $check = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL');
                $check->execute([':slug' => $finalSlug]);
                if ($check->fetch()) {
                    api_response(409, null, 'Share link already exists');
                }
            }
        }

        $finalTitle = $title ?: ($existing['title'] ?? $docId);
        $uploadId = generate_upload_id();
        $stmt = $pdo->prepare('INSERT INTO share_uploads (upload_id, user_id, share_id, type, doc_id, slug, title, password_hash, expires_at, visitor_limit, asset_manifest, status, created_at, updated_at)
            VALUES (:upload_id, :user_id, :share_id, "doc", :doc_id, :slug, :title, :password_hash, :expires_at, :visitor_limit, :asset_manifest, "pending", :created_at, :updated_at)');
        $stmt->execute([
            ':upload_id' => $uploadId,
            ':user_id' => $user['id'],
            ':share_id' => $existing ? (int)$existing['id'] : null,
            ':doc_id' => $docId,
            ':slug' => $finalSlug,
            ':title' => $finalTitle,
            ':password_hash' => $passwordHash,
            ':expires_at' => $expiresValue,
            ':visitor_limit' => $visitorValue,
            ':asset_manifest' => json_encode($assets, JSON_UNESCAPED_SLASHES),
            ':created_at' => now(),
            ':updated_at' => now(),
        ]);
        $insertDoc = $pdo->prepare('INSERT INTO share_upload_docs (upload_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, created_at, updated_at)
            VALUES (:upload_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :created_at, :updated_at)');
        foreach ($docRows as $row) {
            $insertDoc->execute([
                ':upload_id' => $uploadId,
                ':doc_id' => $row['docId'],
                ':title' => $row['title'],
                ':icon' => $row['icon'] !== '' ? $row['icon'] : null,
                ':hpath' => $row['hPath'],
                ':parent_id' => $row['parentId'] !== '' ? $row['parentId'] : null,
                ':sort_index' => $row['sortIndex'],
                ':markdown' => $row['markdown'],
                ':sort_order' => $row['sortOrder'],
                ':size_bytes' => $row['size'],
                ':created_at' => now(),
                ':updated_at' => now(),
            ]);
        }
        api_response(200, ['uploadId' => $uploadId, 'slug' => $finalSlug]);
    }

    if ($path === '/api/v1/shares/notebook/init' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $meta = $payload['metadata'] ?? $payload;
        if (!is_array($meta)) {
            api_response(400, null, 'Invalid metadata');
        }
        $notebookId = trim((string)($meta['notebookId'] ?? ''));
        $title = trim((string)($meta['title'] ?? ''));
        $docs = $meta['docs'] ?? [];
        $password = trim((string)($meta['password'] ?? ''));
        $clearPassword = !empty($meta['clearPassword']);
        $expiresAt = parse_expires_at($meta['expiresAt'] ?? null);
        $clearExpires = !empty($meta['clearExpires']);
        $visitorLimit = parse_visitor_limit($meta['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($meta['clearVisitorLimit']);
        if ($notebookId === '' || !is_array($docs) || count($docs) === 0) {
            api_response(400, null, 'Missing notebook or documents');
        }
        $bannedWords = get_banned_words();
        if (!empty($bannedWords)) {
            foreach ($docs as $doc) {
                $docMarkdown = (string)($doc['markdown'] ?? '');
                if ($docMarkdown === '') {
                    continue;
                }
                $hit = find_banned_word($docMarkdown, $bannedWords);
                if ($hit) {
                    $docTitle = trim((string)($doc['title'] ?? '')) ?: trim((string)($doc['docId'] ?? ''));
                    api_response(400, null, '触发违禁词：' . $hit['word'] . '（文档：' . $docTitle . '）');
                }
            }
        }
        $slug = sanitize_slug((string)($meta['slug'] ?? ''));
        $assets = normalize_asset_manifest($payload['assets'] ?? []);
        $assetSize = 0;
        foreach ($assets as $asset) {
            $assetSize += (int)($asset['size'] ?? 0);
        }
        $docRows = [];
        $docSizeTotal = 0;
        foreach ($docs as $index => $doc) {
            $docId = trim((string)($doc['docId'] ?? ''));
            $docTitle = trim((string)($doc['title'] ?? ''));
            $docIcon = trim((string)($doc['icon'] ?? ''));
            $docHpath = (string)($doc['hPath'] ?? '');
            $docMarkdown = (string)($doc['markdown'] ?? '');
            $docSort = max(0, (int)($doc['sortOrder'] ?? $index));
            $docParent = trim((string)($doc['parentId'] ?? ''));
            $docSortIndex = (float)($doc['sortIndex'] ?? $index);
            if ($docId === '') {
                continue;
            }
            $size = strlen($docMarkdown);
            $docSizeTotal += $size;
            $docRows[] = [
                'docId' => $docId,
                'title' => $docTitle ?: $docId,
                'icon' => $docIcon,
                'hPath' => $docHpath,
                'parentId' => $docParent,
                'sortIndex' => $docSortIndex,
                'markdown' => $docMarkdown,
                'sortOrder' => $docSort,
                'size' => $size,
            ];
        }
        if (empty($docRows)) {
            api_response(400, null, 'No documents to share');
        }
        $baseShareSize = $docSizeTotal + $assetSize;
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE user_id = :uid AND type = "notebook" AND notebook_id = :nid ORDER BY id DESC LIMIT 1');
        $stmt->execute([':uid' => $user['id'], ':nid' => $notebookId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $existingSize = $existing ? (int)($existing['size_bytes'] ?? 0) : 0;
        $commentSize = $existing ? share_comment_size((int)$existing['id']) : 0;
        $commentAssetSize = $existing ? share_comment_asset_size((int)$existing['id']) : 0;
        $newShareSize = $baseShareSize + $commentSize + $commentAssetSize;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if ($limit > 0 && ($usedWithout + $newShareSize) > $limit) {
            api_response(413, null, 'Storage limit reached');
        }

        $passwordHash = $existing['password_hash'] ?? null;
        $expiresValue = isset($existing['expires_at']) ? (int)$existing['expires_at'] : null;
        $visitorValue = isset($existing['visitor_limit']) ? (int)$existing['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }

        $finalSlug = $slug;
        if ($existing) {
            if ($finalSlug && $finalSlug !== $existing['slug']) {
                $check = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL AND id != :id');
                $check->execute([':slug' => $finalSlug, ':id' => $existing['id']]);
                if ($check->fetch()) {
                    api_response(409, null, 'Share link already exists');
                }
            }
            if (!$finalSlug) {
                $finalSlug = (string)$existing['slug'];
            }
        } else {
            if (!$finalSlug) {
                for ($i = 0; $i < 10; $i++) {
                    $finalSlug = sanitize_slug(bin2hex(random_bytes(4)));
                    $check = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL');
                    $check->execute([':slug' => $finalSlug]);
                    if (!$check->fetch()) {
                        break;
                    }
                }
            } else {
                $check = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL');
                $check->execute([':slug' => $finalSlug]);
                if ($check->fetch()) {
                    api_response(409, null, 'Share link already exists');
                }
            }
        }

        $finalTitle = $title ?: ($existing['title'] ?? $notebookId);
        $uploadId = generate_upload_id();
        $stmt = $pdo->prepare('INSERT INTO share_uploads (upload_id, user_id, share_id, type, notebook_id, slug, title, password_hash, expires_at, visitor_limit, asset_manifest, status, created_at, updated_at)
            VALUES (:upload_id, :user_id, :share_id, "notebook", :notebook_id, :slug, :title, :password_hash, :expires_at, :visitor_limit, :asset_manifest, "pending", :created_at, :updated_at)');
        $stmt->execute([
            ':upload_id' => $uploadId,
            ':user_id' => $user['id'],
            ':share_id' => $existing ? (int)$existing['id'] : null,
            ':notebook_id' => $notebookId,
            ':slug' => $finalSlug,
            ':title' => $finalTitle,
            ':password_hash' => $passwordHash,
            ':expires_at' => $expiresValue,
            ':visitor_limit' => $visitorValue,
            ':asset_manifest' => json_encode($assets, JSON_UNESCAPED_SLASHES),
            ':created_at' => now(),
            ':updated_at' => now(),
        ]);
        $stmt = $pdo->prepare('INSERT INTO share_upload_docs (upload_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, created_at, updated_at)
            VALUES (:upload_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :created_at, :updated_at)');
        foreach ($docRows as $row) {
            $stmt->execute([
                ':upload_id' => $uploadId,
                ':doc_id' => $row['docId'],
                ':title' => $row['title'],
                ':icon' => $row['icon'] !== '' ? $row['icon'] : null,
                ':hpath' => $row['hPath'],
                ':parent_id' => $row['parentId'] !== '' ? $row['parentId'] : null,
                ':sort_index' => $row['sortIndex'],
                ':markdown' => $row['markdown'],
                ':sort_order' => $row['sortOrder'],
                ':size_bytes' => $row['size'],
                ':created_at' => now(),
                ':updated_at' => now(),
            ]);
        }
        api_response(200, ['uploadId' => $uploadId, 'slug' => $finalSlug]);
    }

    if ($path === '/api/v1/shares/asset/chunk' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $uploadId = sanitize_upload_id((string)($_POST['uploadId'] ?? ''));
        $assetPath = sanitize_asset_path((string)($_POST['assetPath'] ?? ''));
        $docId = trim((string)($_POST['assetDocId'] ?? ''));
        $chunkIndex = (int)($_POST['chunkIndex'] ?? -1);
        $totalChunks = (int)($_POST['totalChunks'] ?? 0);
        if ($uploadId === '' || $assetPath === '' || $chunkIndex < 0 || $totalChunks <= 0 || $chunkIndex >= $totalChunks) {
            api_response(400, null, 'Invalid chunk request');
        }
        $check = $pdo->prepare('SELECT * FROM share_uploads WHERE upload_id = :upload_id AND user_id = :uid AND status = "pending" LIMIT 1');
        $check->execute([
            ':upload_id' => $uploadId,
            ':uid' => $user['id'],
        ]);
        $upload = $check->fetch(PDO::FETCH_ASSOC);
        if (!$upload) {
            api_response(404, null, 'Upload not found');
        }
        $manifest = json_decode((string)($upload['asset_manifest'] ?? ''), true);
        $manifest = is_array($manifest) ? $manifest : [];
        $manifestItem = null;
        foreach ($manifest as $item) {
            $path = sanitize_asset_path((string)($item['path'] ?? ''));
            if ($path !== '' && $path === $assetPath) {
                $manifestItem = $item;
                break;
            }
        }
        if (!$manifestItem) {
            api_response(400, null, 'Asset not allowed');
        }
        if (empty($_FILES['chunk'])) {
            api_response(400, null, 'Missing chunk file');
        }
        $file = $_FILES['chunk'];
        $chunkSize = (int)($file['size'] ?? 0);
        [$minChunk, $maxChunk] = chunk_size_limits();
        if ($maxChunk > 0 && $chunkSize > $maxChunk) {
            api_response(413, null, 'Chunk too large');
        }
        if ($minChunk > 0 && $chunkIndex < ($totalChunks - 1) && $chunkSize > 0 && $chunkSize < $minChunk) {
            api_response(400, null, 'Chunk too small');
        }
        $tmp = $file['tmp_name'] ?? '';
        if ($tmp === '' || !is_uploaded_file($tmp)) {
            api_response(400, null, 'Invalid chunk upload');
        }

        $chunkDir = upload_chunks_dir($uploadId);
        $chunkPath = $chunkDir . '/' . $assetPath . '.part' . $chunkIndex;
        ensure_dir(dirname($chunkPath));
        if (!move_uploaded_file($tmp, $chunkPath)) {
            api_response(500, null, 'Chunk save failed');
        }

        $complete = false;
        if ($chunkIndex === $totalChunks - 1) {
            $missing = [];
            for ($i = 0; $i < $totalChunks; $i++) {
                $part = $chunkDir . '/' . $assetPath . '.part' . $i;
                if (!is_file($part)) {
                    $missing[] = $i;
                }
            }
            if (!empty($missing)) {
                api_response(409, [
                    'missingChunks' => $missing,
                    'uploadId' => $uploadId,
                    'assetPath' => $assetPath,
                    'totalChunks' => $totalChunks,
                ], 'Missing chunk');
            }
            $targetFile = upload_staging_dir($uploadId) . '/' . $assetPath;
            ensure_dir(dirname($targetFile));
            $out = fopen($targetFile, 'wb');
            if ($out === false) {
                api_response(500, null, 'Failed to open target file');
            }
            for ($i = 0; $i < $totalChunks; $i++) {
                $part = $chunkDir . '/' . $assetPath . '.part' . $i;
                $in = fopen($part, 'rb');
                if ($in === false) {
                    fclose($out);
                    api_response(500, null, 'Failed to read chunk');
                }
                while (!feof($in)) {
                    $buffer = fread($in, 1048576);
                    if ($buffer === false) {
                        break;
                    }
                    fwrite($out, $buffer);
                }
                fclose($in);
                @unlink($part);
            }
            fclose($out);
            $complete = true;
        }
        $stmt = $pdo->prepare('UPDATE share_uploads SET updated_at = :updated_at WHERE upload_id = :upload_id');
        $stmt->execute([
            ':updated_at' => now(),
            ':upload_id' => $uploadId,
        ]);
        api_response(200, ['complete' => $complete]);
    }

    if ($path === '/api/v1/shares/upload/complete' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $uploadId = sanitize_upload_id((string)($payload['uploadId'] ?? ''));
        if ($uploadId === '') {
            api_response(400, null, 'Missing upload id');
        }
        $stmt = $pdo->prepare('SELECT * FROM share_uploads WHERE upload_id = :upload_id AND user_id = :uid AND status = "pending" LIMIT 1');
        $stmt->execute([
            ':upload_id' => $uploadId,
            ':uid' => $user['id'],
        ]);
        $upload = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$upload) {
            api_response(404, null, 'Upload not found');
        }

        $docStmt = $pdo->prepare('SELECT * FROM share_upload_docs WHERE upload_id = :upload_id ORDER BY id ASC');
        $docStmt->execute([':upload_id' => $uploadId]);
        $docRows = $docStmt->fetchAll(PDO::FETCH_ASSOC);
        if (empty($docRows)) {
            api_response(400, null, 'Missing documents');
        }
        $docSizeTotal = 0;
        foreach ($docRows as $row) {
            $docSizeTotal += (int)($row['size_bytes'] ?? 0);
        }

        $manifest = json_decode((string)($upload['asset_manifest'] ?? ''), true);
        $manifest = is_array($manifest) ? $manifest : [];
        $assetSizeTotal = 0;
        $stagingDir = upload_staging_dir($uploadId);
        $manifestEntries = [];
        foreach ($manifest as $item) {
            $path = sanitize_asset_path((string)($item['path'] ?? ''));
            if ($path === '') {
                continue;
            }
            $full = $stagingDir . '/' . $path;
            if (!is_file($full)) {
                api_response(400, null, 'Missing asset: ' . $path);
            }
            $size = (int)filesize($full);
            $assetSizeTotal += $size;
            $manifestEntries[] = [
                'path' => $path,
                'docId' => isset($item['docId']) ? trim((string)$item['docId']) : null,
                'size' => $size,
            ];
        }

        $share = null;
        $shareId = (int)($upload['share_id'] ?? 0);
        if ($shareId > 0) {
            $check = $pdo->prepare('SELECT * FROM shares WHERE id = :id AND user_id = :uid LIMIT 1');
            $check->execute([
                ':id' => $shareId,
                ':uid' => $user['id'],
            ]);
            $share = $check->fetch(PDO::FETCH_ASSOC) ?: null;
            if (!$share) {
                $shareId = 0;
            }
        }

            $baseShareSize = $docSizeTotal + $assetSizeTotal;
            $commentSize = share_comment_size($shareId);
            $commentAssetSize = share_comment_asset_size($shareId);
            $newShareSize = $baseShareSize + $commentSize + $commentAssetSize;
        $existingSize = $share ? (int)($share['size_bytes'] ?? 0) : 0;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if ($limit > 0 && ($usedWithout + $newShareSize) > $limit) {
            api_response(413, null, 'Storage limit reached');
        }

        $slug = sanitize_slug((string)($upload['slug'] ?? ''));
        if ($slug === '') {
            for ($i = 0; $i < 10; $i++) {
                $slug = sanitize_slug(bin2hex(random_bytes(4)));
                $check = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL');
                $check->execute([':slug' => $slug]);
                if (!$check->fetch()) {
                    break;
                }
            }
        } else {
            $check = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL');
            $check->execute([':slug' => $slug]);
            $rowId = (int)($check->fetchColumn() ?: 0);
            if ($rowId && (!$share || $rowId !== (int)$share['id'])) {
                api_response(409, null, 'Share link already exists');
            }
        }

        $title = trim((string)($upload['title'] ?? ''));
        $passwordHash = $upload['password_hash'] ?? null;
        $expiresValue = isset($upload['expires_at']) ? (int)$upload['expires_at'] : null;
        $visitorValue = isset($upload['visitor_limit']) ? (int)$upload['visitor_limit'] : 0;
        $type = (string)($upload['type'] ?? 'doc');
        $docId = trim((string)($upload['doc_id'] ?? ''));
        $notebookId = trim((string)($upload['notebook_id'] ?? ''));

        $pdo->beginTransaction();
        try {
            if ($share) {
                $update = $pdo->prepare('UPDATE shares SET title = :title, slug = :slug, password_hash = :password_hash, expires_at = :expires_at, visitor_limit = :visitor_limit, updated_at = :updated_at, deleted_at = NULL WHERE id = :id');
                $update->execute([
                    ':title' => $title !== '' ? $title : ($share['title'] ?? $slug),
                    ':slug' => $slug,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':updated_at' => now(),
                    ':id' => $share['id'],
                ]);
                $shareId = (int)$share['id'];
                purge_share_assets($shareId, true);
                purge_share_chunks($shareId);
                $pdo->prepare('DELETE FROM share_docs WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
            } else {
                $shareId = allocate_share_id($pdo);
                if ($shareId > 0) {
                    $stmt = $pdo->prepare('INSERT INTO shares (id, user_id, type, slug, title, doc_id, notebook_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                        VALUES (:id, :uid, :type, :slug, :title, :doc_id, :notebook_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                    $stmt->execute([
                        ':id' => $shareId,
                        ':uid' => $user['id'],
                        ':type' => $type,
                        ':slug' => $slug,
                        ':title' => $title !== '' ? $title : $slug,
                        ':doc_id' => $type === 'doc' ? $docId : null,
                        ':notebook_id' => $type === 'notebook' ? $notebookId : null,
                        ':password_hash' => $passwordHash,
                        ':expires_at' => $expiresValue,
                        ':visitor_limit' => $visitorValue,
                        ':created_at' => now(),
                        ':updated_at' => now(),
                    ]);
                } else {
                    $stmt = $pdo->prepare('INSERT INTO shares (user_id, type, slug, title, doc_id, notebook_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                        VALUES (:uid, :type, :slug, :title, :doc_id, :notebook_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                    $stmt->execute([
                        ':uid' => $user['id'],
                        ':type' => $type,
                        ':slug' => $slug,
                        ':title' => $title !== '' ? $title : $slug,
                        ':doc_id' => $type === 'doc' ? $docId : null,
                        ':notebook_id' => $type === 'notebook' ? $notebookId : null,
                        ':password_hash' => $passwordHash,
                        ':expires_at' => $expiresValue,
                        ':visitor_limit' => $visitorValue,
                        ':created_at' => now(),
                        ':updated_at' => now(),
                    ]);
                    $shareId = (int)$pdo->lastInsertId();
                }
            }

            $insertDoc = $pdo->prepare('INSERT INTO share_docs (share_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, created_at, updated_at)
                VALUES (:share_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :created_at, :updated_at)');
            foreach ($docRows as $row) {
                $insertDoc->execute([
                    ':share_id' => $shareId,
                    ':doc_id' => $row['doc_id'],
                    ':title' => $row['title'],
                    ':icon' => isset($row['icon']) && trim((string)$row['icon']) !== '' ? $row['icon'] : null,
                    ':hpath' => $row['hpath'],
                    ':parent_id' => $row['parent_id'] ?? null,
                    ':sort_index' => $row['sort_index'] ?? 0,
                    ':markdown' => $row['markdown'],
                    ':sort_order' => $row['sort_order'] ?? 0,
                    ':size_bytes' => $row['size_bytes'] ?? 0,
                    ':created_at' => now(),
                    ':updated_at' => now(),
                ]);
            }

            $targetDir = $config['uploads_dir'] . '/shares/' . $shareId;
            if (is_dir($stagingDir)) {
                move_dir($stagingDir, $targetDir);
            } else {
                ensure_dir($targetDir);
            }

            if (!empty($manifestEntries)) {
                $assetStmt = $pdo->prepare('INSERT OR REPLACE INTO share_assets (share_id, doc_id, asset_path, file_path, size_bytes, created_at)
                    VALUES (:share_id, :doc_id, :asset_path, :file_path, :size_bytes, :created_at)');
                foreach ($manifestEntries as $entry) {
                    $assetStmt->execute([
                        ':share_id' => $shareId,
                        ':doc_id' => $entry['docId'] !== '' ? $entry['docId'] : null,
                        ':asset_path' => $entry['path'],
                        ':file_path' => 'shares/' . $shareId . '/' . $entry['path'],
                        ':size_bytes' => $entry['size'],
                        ':created_at' => now(),
                    ]);
                }
            }

            $updateSize = $pdo->prepare('UPDATE shares SET size_bytes = :size_bytes, updated_at = :updated_at WHERE id = :id');
            $updateSize->execute([
                ':size_bytes' => $newShareSize,
                ':updated_at' => now(),
                ':id' => $shareId,
            ]);

            $pdo->prepare('DELETE FROM share_upload_docs WHERE upload_id = :upload_id')->execute([':upload_id' => $uploadId]);
            $pdo->prepare('DELETE FROM share_uploads WHERE upload_id = :upload_id')->execute([':upload_id' => $uploadId]);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            api_response(500, null, 'Upload finalize failed');
        }

        if (!empty($visitorValue)) {
            seed_share_visitors_from_logs($shareId);
        }
        purge_upload_session_files($uploadId);
        recalculate_user_storage((int)$user['id']);
        api_response(200, [
            'shareId' => $shareId,
            'slug' => $slug,
            'url' => share_url($slug),
        ]);
    }

    if ($path === '/api/v1/shares/upload/cancel' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $payload = parse_json_body();
        $uploadId = sanitize_upload_id((string)($payload['uploadId'] ?? ''));
        if ($uploadId === '') {
            api_response(400, null, 'Missing upload id');
        }
        $stmt = $pdo->prepare('SELECT id FROM share_uploads WHERE upload_id = :upload_id AND user_id = :uid LIMIT 1');
        $stmt->execute([
            ':upload_id' => $uploadId,
            ':uid' => $user['id'],
        ]);
        if (!$stmt->fetchColumn()) {
            api_response(404, null, 'Upload not found');
        }
        $pdo->prepare('DELETE FROM share_upload_docs WHERE upload_id = :upload_id')->execute([':upload_id' => $uploadId]);
        $pdo->prepare('DELETE FROM share_uploads WHERE upload_id = :upload_id')->execute([':upload_id' => $uploadId]);
        purge_upload_session_files($uploadId);
        api_response(200, ['ok' => true]);
    }

    if ($path === '/api/v1/shares/doc') {
        $metaRaw = $_POST['metadata'] ?? '';
        if (!$metaRaw) {
            $metaRaw = json_encode(parse_json_body());
        }
        $meta = json_decode($metaRaw, true);
        if (!is_array($meta)) {
            api_response(400, null, '数据格式错误');
        }
        $docId = trim((string)($meta['docId'] ?? ''));
        $title = trim((string)($meta['title'] ?? ''));
        $markdown = (string)($meta['markdown'] ?? '');
        $hPath = (string)($meta['hPath'] ?? '');
        $sortOrder = max(0, (int)($meta['sortOrder'] ?? 0));
        $password = trim((string)($meta['password'] ?? ''));
        $clearPassword = !empty($meta['clearPassword']);
        $expiresAt = parse_expires_at($meta['expiresAt'] ?? null);
        $clearExpires = !empty($meta['clearExpires']);
        $visitorLimit = parse_visitor_limit($meta['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($meta['clearVisitorLimit']);
        $docs = $meta['docs'] ?? [];
        $hasDocs = is_array($docs) && count($docs) > 0;
        if ($docId === '' || (!$hasDocs && $markdown === '')) {
            api_response(400, null, '缺少文档内容');
        }
        $bannedWords = get_banned_words();
        if (!empty($bannedWords)) {
            if ($hasDocs) {
                foreach ($docs as $doc) {
                    $docMarkdown = (string)($doc['markdown'] ?? '');
                    if ($docMarkdown === '') {
                        continue;
                    }
                    $hit = find_banned_word($docMarkdown, $bannedWords);
                    if ($hit) {
                        $docTitle = trim((string)($doc['title'] ?? '')) ?: trim((string)($doc['docId'] ?? ''));
                        api_response(400, null, '触发违禁词：' . $hit['word'] . '（文档：' . $docTitle . '）');
                    }
                }
            } else {
                $hit = find_banned_word($markdown, $bannedWords);
                if ($hit) {
                    api_response(400, null, '触发违禁词：' . $hit['word']);
                }
            }
        }
        $slug = sanitize_slug((string)($meta['slug'] ?? ''));
        $paths = $_POST['assetPaths'] ?? [];
        $docIds = $_POST['assetDocIds'] ?? [];
        $paths = is_array($paths) ? $paths : [$paths];
        $docIds = is_array($docIds) ? $docIds : [$docIds];
        $entries = [];
        if (!empty($_FILES['assets'])) {
            $entries = collect_asset_entries($_FILES['assets'], $paths, $docIds);
        }
        $assetSize = 0;
        foreach ($entries as $entry) {
            $assetSize += (int)($entry['size'] ?? 0);
        }
        $docRows = [];
        $docSizeTotal = 0;
        if ($hasDocs) {
            foreach ($docs as $index => $doc) {
                $rowDocId = trim((string)($doc['docId'] ?? ''));
                $rowTitle = trim((string)($doc['title'] ?? ''));
                $rowIcon = trim((string)($doc['icon'] ?? ''));
                $rowHpath = (string)($doc['hPath'] ?? '');
                $rowMarkdown = (string)($doc['markdown'] ?? '');
                $rowSort = max(0, (int)($doc['sortOrder'] ?? $index));
                $rowParent = trim((string)($doc['parentId'] ?? ''));
                $rowSortIndex = (float)($doc['sortIndex'] ?? $index);
                if ($rowDocId === '') {
                    continue;
                }
                $size = strlen($rowMarkdown);
                $docSizeTotal += $size;
                $docRows[] = [
                    'docId' => $rowDocId,
                    'title' => $rowTitle ?: $rowDocId,
                    'icon' => $rowIcon,
                    'hPath' => $rowHpath,
                    'parentId' => $rowParent,
                    'sortIndex' => $rowSortIndex,
                    'markdown' => $rowMarkdown,
                    'sortOrder' => $rowSort,
                    'size' => $size,
                ];
            }
            if (empty($docRows)) {
                api_response(400, null, '缺少文档内容');
            }
        } else {
            $docSizeTotal = strlen($markdown);
            $docIcon = trim((string)($meta['icon'] ?? ''));
            $docRows[] = [
                'docId' => $docId,
                'title' => $title ?: $docId,
                'icon' => $docIcon,
                'hPath' => $hPath,
                'parentId' => null,
                'sortIndex' => 0,
                'markdown' => $markdown,
                'sortOrder' => $sortOrder,
                'size' => $docSizeTotal,
            ];
        }
        $baseShareSize = $docSizeTotal + $assetSize;
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE user_id = :uid AND type = "doc" AND doc_id = :doc_id ORDER BY id DESC LIMIT 1');
        $stmt->execute([':uid' => $user['id'], ':doc_id' => $docId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $existingSize = $existing ? (int)($existing['size_bytes'] ?? 0) : 0;
        $commentSize = $existing ? share_comment_size((int)$existing['id']) : 0;
        $commentAssetSize = $existing ? share_comment_asset_size((int)$existing['id']) : 0;
        $newShareSize = $baseShareSize + $commentSize + $commentAssetSize;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if ($limit > 0 && ($usedWithout + $newShareSize) > $limit) {
            api_response(413, null, '存储空间不足，请清理后重试');
        }

        $passwordHash = $existing['password_hash'] ?? null;
        $expiresValue = isset($existing['expires_at']) ? (int)$existing['expires_at'] : null;
        $visitorValue = isset($existing['visitor_limit']) ? (int)$existing['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }

        if ($existing) {
            if ($slug && $slug !== $existing['slug']) {
                $check = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL AND id != :id');
                $check->execute([':slug' => $slug, ':id' => $existing['id']]);
                if ($check->fetch()) {
                    api_response(409, null, '分享链接已被占用');
                }
            }
            $newSlug = $slug ?: $existing['slug'];
            $stmt = $pdo->prepare('UPDATE shares SET title = :title, slug = :slug, password_hash = :password_hash, expires_at = :expires_at, visitor_limit = :visitor_limit, updated_at = :updated_at, deleted_at = NULL WHERE id = :id');
            $stmt->execute([
                ':title' => $title ?: $existing['title'],
                ':slug' => $newSlug,
                ':password_hash' => $passwordHash,
                ':expires_at' => $expiresValue,
                ':visitor_limit' => $visitorValue,
                ':updated_at' => now(),
                ':id' => $existing['id'],
            ]);
            $shareId = (int)$existing['id'];
            $slug = $newSlug;
        } else {
            if (!$slug) {
                for ($i = 0; $i < 10; $i++) {
                    $slug = sanitize_slug(bin2hex(random_bytes(4)));
                    $check = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL');
                    $check->execute([':slug' => $slug]);
                    if (!$check->fetch()) {
                        break;
                    }
                }
            } else {
                $check = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL');
                $check->execute([':slug' => $slug]);
                if ($check->fetch()) {
                    api_response(409, null, '分享链接已被占用');
                }
            }
            $shareId = allocate_share_id($pdo);
            if ($shareId > 0) {
                $stmt = $pdo->prepare('INSERT INTO shares (id, user_id, type, slug, title, doc_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                    VALUES (:id, :uid, "doc", :slug, :title, :doc_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                $stmt->execute([
                    ':id' => $shareId,
                    ':uid' => $user['id'],
                    ':slug' => $slug,
                    ':title' => $title ?: $docId,
                    ':doc_id' => $docId,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':created_at' => now(),
                    ':updated_at' => now(),
                ]);
            } else {
                $stmt = $pdo->prepare('INSERT INTO shares (user_id, type, slug, title, doc_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                    VALUES (:uid, "doc", :slug, :title, :doc_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                $stmt->execute([
                    ':uid' => $user['id'],
                    ':slug' => $slug,
                    ':title' => $title ?: $docId,
                    ':doc_id' => $docId,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':created_at' => now(),
                    ':updated_at' => now(),
                ]);
                $shareId = (int)$pdo->lastInsertId();
            }
        }

        if ($existing) {
            purge_share_assets($shareId, true);
        }
        if (!empty($visitorValue)) {
            seed_share_visitors_from_logs($shareId);
        }
        $pdo->prepare('DELETE FROM share_docs WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
        $insertDoc = $pdo->prepare('INSERT INTO share_docs (share_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, created_at, updated_at)
            VALUES (:share_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :created_at, :updated_at)');
        foreach ($docRows as $row) {
            $insertDoc->execute([
                ':share_id' => $shareId,
                ':doc_id' => $row['docId'],
                ':title' => $row['title'],
                ':icon' => $row['icon'] !== '' ? $row['icon'] : null,
                ':hpath' => $row['hPath'],
                ':parent_id' => $row['parentId'] !== '' ? $row['parentId'] : null,
                ':sort_index' => $row['sortIndex'],
                ':markdown' => $row['markdown'],
                ':sort_order' => $row['sortOrder'],
                ':size_bytes' => $row['size'],
                ':created_at' => now(),
                ':updated_at' => now(),
            ]);
        }

        $actualAssets = handle_asset_uploads($shareId, $entries);
        $finalSize = $docSizeTotal + $actualAssets + share_comment_size($shareId) + share_comment_asset_size($shareId);
        $stmt = $pdo->prepare('UPDATE shares SET size_bytes = :size_bytes, updated_at = :updated_at WHERE id = :id');
        $stmt->execute([
            ':size_bytes' => $finalSize,
            ':updated_at' => now(),
            ':id' => $shareId,
        ]);
        recalculate_user_storage((int)$user['id']);

        api_response(200, ['share' => [
            'id' => $shareId,
            'slug' => $slug,
            'url' => share_url($slug),
        ]]);
    }

    if ($path === '/api/v1/shares/notebook') {
        $metaRaw = $_POST['metadata'] ?? '';
        if (!$metaRaw) {
            $metaRaw = json_encode(parse_json_body());
        }
        $meta = json_decode($metaRaw, true);
        if (!is_array($meta)) {
            api_response(400, null, '数据格式错误');
        }
        $notebookId = trim((string)($meta['notebookId'] ?? ''));
        $title = trim((string)($meta['title'] ?? ''));
        $docs = $meta['docs'] ?? [];
        $password = trim((string)($meta['password'] ?? ''));
        $clearPassword = !empty($meta['clearPassword']);
        $expiresAt = parse_expires_at($meta['expiresAt'] ?? null);
        $clearExpires = !empty($meta['clearExpires']);
        $visitorLimit = parse_visitor_limit($meta['visitorLimit'] ?? null);
        $clearVisitorLimit = !empty($meta['clearVisitorLimit']);
        if ($notebookId === '' || !is_array($docs) || count($docs) === 0) {
            api_response(400, null, '缺少笔记本 ID 或文档数据');
        }
        $bannedWords = get_banned_words();
        if (!empty($bannedWords)) {
            foreach ($docs as $doc) {
                $docMarkdown = (string)($doc['markdown'] ?? '');
                if ($docMarkdown === '') {
                    continue;
                }
                $hit = find_banned_word($docMarkdown, $bannedWords);
                if ($hit) {
                    $docTitle = trim((string)($doc['title'] ?? '')) ?: trim((string)($doc['docId'] ?? ''));
                    api_response(400, null, '触发违禁词：' . $hit['word'] . '（文档：' . $docTitle . '）');
                }
            }
        }
        $slug = sanitize_slug((string)($meta['slug'] ?? ''));
        $paths = $_POST['assetPaths'] ?? [];
        $docIds = $_POST['assetDocIds'] ?? [];
        $paths = is_array($paths) ? $paths : [$paths];
        $docIds = is_array($docIds) ? $docIds : [$docIds];
        $entries = [];
        if (!empty($_FILES['assets'])) {
            $entries = collect_asset_entries($_FILES['assets'], $paths, $docIds);
        }
        $assetSize = 0;
        foreach ($entries as $entry) {
            $assetSize += (int)($entry['size'] ?? 0);
        }
        $docRows = [];
        $docSizeTotal = 0;
        foreach ($docs as $index => $doc) {
            $docId = trim((string)($doc['docId'] ?? ''));
            $docTitle = trim((string)($doc['title'] ?? ''));
            $docIcon = trim((string)($doc['icon'] ?? ''));
            $docHpath = (string)($doc['hPath'] ?? '');
            $docMarkdown = (string)($doc['markdown'] ?? '');
            $docSort = max(0, (int)($doc['sortOrder'] ?? $index));
            $docParent = trim((string)($doc['parentId'] ?? ''));
            $docSortIndex = (float)($doc['sortIndex'] ?? $index);
            if ($docId === '') {
                continue;
            }
            $size = strlen($docMarkdown);
            $docSizeTotal += $size;
            $docRows[] = [
                'docId' => $docId,
                'title' => $docTitle ?: $docId,
                'icon' => $docIcon,
                'hPath' => $docHpath,
                'parentId' => $docParent,
                'sortIndex' => $docSortIndex,
                'markdown' => $docMarkdown,
                'sortOrder' => $docSort,
                'size' => $size,
            ];
        }
        if (empty($docRows)) {
            api_response(400, null, '没有可用的文档');
        }
        $baseShareSize = $docSizeTotal + $assetSize;
        $stmt = $pdo->prepare('SELECT * FROM shares WHERE user_id = :uid AND type = "notebook" AND notebook_id = :nid ORDER BY id DESC LIMIT 1');
        $stmt->execute([':uid' => $user['id'], ':nid' => $notebookId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $existingSize = $existing ? (int)($existing['size_bytes'] ?? 0) : 0;
        $commentSize = $existing ? share_comment_size((int)$existing['id']) : 0;
        $commentAssetSize = $existing ? share_comment_asset_size((int)$existing['id']) : 0;
        $newShareSize = $baseShareSize + $commentSize + $commentAssetSize;
        $used = recalculate_user_storage((int)$user['id']);
        $limit = get_user_limit_bytes($user);
        $usedWithout = max(0, $used - $existingSize);
        if ($limit > 0 && ($usedWithout + $newShareSize) > $limit) {
            api_response(413, null, '存储空间不足，请清理后重试');
        }

        $passwordHash = $existing['password_hash'] ?? null;
        $expiresValue = isset($existing['expires_at']) ? (int)$existing['expires_at'] : null;
        $visitorValue = isset($existing['visitor_limit']) ? (int)$existing['visitor_limit'] : 0;
        if ($clearPassword) {
            $passwordHash = null;
        } elseif ($password !== '') {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        }
        if ($clearExpires) {
            $expiresValue = null;
        } elseif ($expiresAt !== null) {
            $expiresValue = $expiresAt;
        }
        if ($clearVisitorLimit) {
            $visitorValue = 0;
        } elseif ($visitorLimit !== null) {
            $visitorValue = $visitorLimit;
        }

        if ($existing) {
            if ($slug && $slug !== $existing['slug']) {
                $check = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL AND id != :id');
                $check->execute([':slug' => $slug, ':id' => $existing['id']]);
                if ($check->fetch()) {
                    api_response(409, null, '分享链接已被占用');
                }
            }
            $newSlug = $slug ?: $existing['slug'];
            $stmt = $pdo->prepare('UPDATE shares SET title = :title, slug = :slug, password_hash = :password_hash, expires_at = :expires_at, visitor_limit = :visitor_limit, updated_at = :updated_at, deleted_at = NULL WHERE id = :id');
            $stmt->execute([
                ':title' => $title ?: $existing['title'],
                ':slug' => $newSlug,
                ':password_hash' => $passwordHash,
                ':expires_at' => $expiresValue,
                ':visitor_limit' => $visitorValue,
                ':updated_at' => now(),
                ':id' => $existing['id'],
            ]);
            $shareId = (int)$existing['id'];
            $slug = $newSlug;
        } else {
            if (!$slug) {
                for ($i = 0; $i < 10; $i++) {
                    $slug = sanitize_slug(bin2hex(random_bytes(4)));
                    $check = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL');
                    $check->execute([':slug' => $slug]);
                    if (!$check->fetch()) {
                        break;
                    }
                }
            } else {
                $check = $pdo->prepare('SELECT id FROM shares WHERE slug = :slug AND deleted_at IS NULL');
                $check->execute([':slug' => $slug]);
                if ($check->fetch()) {
                    api_response(409, null, '分享链接已被占用');
                }
            }
            $shareId = allocate_share_id($pdo);
            if ($shareId > 0) {
                $stmt = $pdo->prepare('INSERT INTO shares (id, user_id, type, slug, title, notebook_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                    VALUES (:id, :uid, "notebook", :slug, :title, :notebook_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                $stmt->execute([
                    ':id' => $shareId,
                    ':uid' => $user['id'],
                    ':slug' => $slug,
                    ':title' => $title ?: $notebookId,
                    ':notebook_id' => $notebookId,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':created_at' => now(),
                    ':updated_at' => now(),
                ]);
            } else {
                $stmt = $pdo->prepare('INSERT INTO shares (user_id, type, slug, title, notebook_id, password_hash, expires_at, visitor_limit, created_at, updated_at)
                    VALUES (:uid, "notebook", :slug, :title, :notebook_id, :password_hash, :expires_at, :visitor_limit, :created_at, :updated_at)');
                $stmt->execute([
                    ':uid' => $user['id'],
                    ':slug' => $slug,
                    ':title' => $title ?: $notebookId,
                    ':notebook_id' => $notebookId,
                    ':password_hash' => $passwordHash,
                    ':expires_at' => $expiresValue,
                    ':visitor_limit' => $visitorValue,
                    ':created_at' => now(),
                    ':updated_at' => now(),
                ]);
                $shareId = (int)$pdo->lastInsertId();
            }
        }

        if ($existing) {
            purge_share_assets($shareId, true);
        }
        if (!empty($visitorValue)) {
            seed_share_visitors_from_logs($shareId);
        }
        $pdo->prepare('DELETE FROM share_docs WHERE share_id = :share_id')->execute([':share_id' => $shareId]);
        $stmt = $pdo->prepare('INSERT INTO share_docs (share_id, doc_id, title, icon, hpath, parent_id, sort_index, markdown, sort_order, size_bytes, created_at, updated_at)
            VALUES (:share_id, :doc_id, :title, :icon, :hpath, :parent_id, :sort_index, :markdown, :sort_order, :size_bytes, :created_at, :updated_at)');
        foreach ($docRows as $row) {
            $stmt->execute([
                ':share_id' => $shareId,
                ':doc_id' => $row['docId'],
                ':title' => $row['title'],
                ':icon' => $row['icon'] !== '' ? $row['icon'] : null,
                ':hpath' => $row['hPath'],
                ':parent_id' => $row['parentId'] !== '' ? $row['parentId'] : null,
                ':sort_index' => $row['sortIndex'],
                ':markdown' => $row['markdown'],
                ':sort_order' => (int)$row['sortOrder'],
                ':size_bytes' => $row['size'],
                ':created_at' => now(),
                ':updated_at' => now(),
            ]);
        }

        $actualAssets = handle_asset_uploads($shareId, $entries);
        $finalSize = $docSizeTotal + $actualAssets + share_comment_size($shareId) + share_comment_asset_size($shareId);
        $stmt = $pdo->prepare('UPDATE shares SET size_bytes = :size_bytes, updated_at = :updated_at WHERE id = :id');
        $stmt->execute([
            ':size_bytes' => $finalSize,
            ':updated_at' => now(),
            ':id' => $shareId,
        ]);
        recalculate_user_storage((int)$user['id']);

        api_response(200, ['share' => [
            'id' => $shareId,
            'slug' => $slug,
            'url' => share_url($slug),
        ]]);
    }

    api_response(404, null, '接口不存在');
}

function rewrite_asset_links(string $markdown, string $assetBase = ''): string {
    $prefix = $assetBase;
    if ($prefix !== '' && substr($prefix, -1) !== '/') {
        $prefix .= '/';
    }
    $markdown = str_replace('](/assets/', '](' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](./assets/', '](' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](assets/', '](' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](<assets/', '](<' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](</assets/', '](<' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('src="/assets/', 'src="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('src="./assets/', 'src="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('src="assets/', 'src="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('href="/assets/', 'href="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('href="./assets/', 'href="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('href="assets/', 'href="' . $prefix . 'assets/', $markdown);
    $markdown = str_replace('](/emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](./emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](<emojis/', '](<' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](</emojis/', '](<' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="/emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="./emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="/emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="./emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](/emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](./emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('](emojis/', '](' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="/emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="./emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('src="emojis/', 'src="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="/emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="./emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    $markdown = str_replace('href="emojis/', 'href="' . $prefix . 'emojis/', $markdown);
    return $markdown;
}

function encode_path_segments(string $path): string {
    $parts = explode('/', $path);
    $encoded = array_map(static fn($part) => rawurlencode($part), $parts);
    return implode('/', $encoded);
}

function sanitize_emoji_token_name(string $token): string {
    $token = trim($token);
    if ($token === '' || $token[0] !== ':' || substr($token, -1) !== ':') {
        return '';
    }
    $name = trim(substr($token, 1, -1));
    if ($name === '' || strpos($name, "\n") !== false || strpos($name, "\r") !== false) {
        return '';
    }
    if (strpos($name, ':') !== false) {
        return '';
    }
    return $name;
}

function normalize_emoji_key(string $name): string {
    $value = strtolower(trim($name));
    if ($value === '') {
        return '';
    }
    $normalized = preg_replace('/[\s_-]+/', '', $value);
    return $normalized ?? '';
}

function resolve_custom_emoji_src(string $name, int $shareId, string $assetBasePath): string {
    global $config;
    static $cache = [];
    $key = $shareId . '|' . $name;
    if (isset($cache[$key])) {
        return $cache[$key];
    }
    $clean = str_replace('\\', '/', $name);
    $clean = ltrim($clean, '/');
    if ($clean === '' || strpos($clean, '..') !== false) {
        $cache[$key] = '';
        return '';
    }
    $decoded = rawurldecode($clean);
    $candidates = [$clean];
    if ($decoded !== '' && $decoded !== $clean) {
        $candidates[] = $decoded;
    }
    $compact = preg_replace('/\s+/', '', $clean);
    if ($compact !== $clean && $compact !== '') {
        $candidates[] = $compact;
    }
    $extensions = ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
    $uploadsDir = (string)($config['uploads_dir'] ?? (__DIR__ . '/uploads'));
    $uploadsDir = rtrim($uploadsDir, '/\\');
    $fsBase = $uploadsDir . '/shares/' . $shareId . '/emojis/';
    foreach ($candidates as $candidate) {
        $hasExt = (bool)preg_match('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', $candidate);
        $names = $hasExt ? [$candidate] : array_merge([$candidate], array_map(
            static fn($ext) => $candidate . '.' . $ext,
            $extensions
        ));
        foreach ($names as $file) {
            $fsPath = $fsBase . $file;
            if (is_file($fsPath)) {
                $rel = 'emojis/' . $file;
                $cache[$key] = $assetBasePath . encode_path_segments($rel);
                return $cache[$key];
            }
        }
    }
    $index = build_share_emoji_index($shareId, $uploadsDir);
    if (!empty($index)) {
        $normalizedIndex = [];
        foreach ($index as $nameKey => $rel) {
            $norm = normalize_emoji_key($nameKey);
            if ($norm !== '' && !isset($normalizedIndex[$norm])) {
                $normalizedIndex[$norm] = $rel;
            }
        }
        foreach ($candidates as $candidate) {
            if (isset($index[$candidate])) {
                $cache[$key] = $assetBasePath . encode_path_segments($index[$candidate]);
                return $cache[$key];
            }
            $lower = strtolower($candidate);
            foreach ($index as $nameKey => $rel) {
                if (strtolower($nameKey) === $lower) {
                    $cache[$key] = $assetBasePath . encode_path_segments($rel);
                    return $cache[$key];
                }
            }
            foreach ($index as $nameKey => $rel) {
                if (str_starts_with($nameKey, $candidate . '-')) {
                    $cache[$key] = $assetBasePath . encode_path_segments($rel);
                    return $cache[$key];
                }
            }
            if (!empty($normalizedIndex)) {
                $normalized = normalize_emoji_key($candidate);
                if ($normalized !== '' && isset($normalizedIndex[$normalized])) {
                    $cache[$key] = $assetBasePath . encode_path_segments($normalizedIndex[$normalized]);
                    return $cache[$key];
                }
            }
        }
    }
    $cache[$key] = '';
    return '';
}

function build_share_emoji_index(int $shareId, string $uploadsDir): array {
    static $cache = [];
    $key = $uploadsDir . '|' . $shareId;
    if (isset($cache[$key])) {
        return $cache[$key];
    }
    $map = [];
    if ($shareId <= 0 || $uploadsDir === '') {
        $cache[$key] = $map;
        return $map;
    }
    $root = rtrim($uploadsDir, '/\\') . '/shares/' . $shareId . '/emojis';
    if (!is_dir($root)) {
        $cache[$key] = $map;
        return $map;
    }
    try {
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)
        );
        foreach ($iterator as $file) {
            if (!$file->isFile()) {
                continue;
            }
            $fullPath = str_replace('\\', '/', $file->getPathname());
            if (!preg_match('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', $fullPath)) {
                continue;
            }
            $relative = substr($fullPath, strlen(rtrim($root, '/\\')) + 1);
            if ($relative === false || $relative === '') {
                continue;
            }
            $relative = ltrim(str_replace('\\', '/', $relative), '/');
            $name = preg_replace('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', '', $relative);
            if ($name === '') {
                continue;
            }
            $map[$name] = 'emojis/' . $relative;
            $baseName = basename($name);
            if ($baseName !== '' && !isset($map[$baseName])) {
                $map[$baseName] = 'emojis/' . $relative;
            }
        }
    } catch (Throwable $err) {
        // ignore
    }
    try {
        $pdo = db();
        $stmt = $pdo->prepare('SELECT asset_path FROM share_assets WHERE share_id = :sid AND asset_path LIKE :prefix');
        $stmt->execute([
            ':sid' => $shareId,
            ':prefix' => 'emojis/%',
        ]);
        $rows = $stmt->fetchAll(PDO::FETCH_COLUMN);
        foreach ($rows as $path) {
            $path = sanitize_asset_path((string)$path);
            if ($path === '' || !str_starts_with($path, 'emojis/')) {
                continue;
            }
            $relative = substr($path, strlen('emojis/'));
            if ($relative === '' || substr($relative, -1) === '/') {
                continue;
            }
            $name = preg_replace('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', '', $relative);
            if ($name === '' || isset($map[$name])) {
                continue;
            }
            $map[$name] = $path;
            $baseName = basename($name);
            if ($baseName !== '' && !isset($map[$baseName])) {
                $map[$baseName] = $path;
            }
        }
    } catch (Throwable $err) {
        // ignore
    }
    $cache[$key] = $map;
    return $map;
}

function get_fence_marker(string $text, int $index): string {
    $ch = $text[$index] ?? '';
    if ($ch !== '`' && $ch !== '~') {
        return '';
    }
    $marker = substr($text, $index, 3);
    if ($marker !== '```' && $marker !== '~~~') {
        return '';
    }
    $i = $index - 1;
    while ($i >= 0 && $text[$i] === ' ') {
        $i--;
    }
    if ($i >= 0 && $text[$i] !== "\n") {
        return '';
    }
    return $marker;
}

function get_emoji_token_name_at(string $text, int $index): string {
    $len = strlen($text);
    if ($index < 0 || $index >= $len) {
        return '';
    }
    if ($text[$index] !== ':') {
        return '';
    }
    $end = strpos($text, ':', $index + 1);
    if ($end === false || $end <= $index + 1) {
        return '';
    }
    return sanitize_emoji_token_name(substr($text, $index, $end - $index + 1));
}

function replace_custom_emoji_tokens(string $markdown, int $shareId, string $assetBasePath): string {
    $source = (string)$markdown;
    if ($source === '') {
        return $source;
    }
    $len = strlen($source);
    $out = '';
    $inFence = false;
    $fenceMarker = '';
    $inInline = false;
    $inTag = false;
    $i = 0;
    while ($i < $len) {
        $fence = $inTag ? '' : get_fence_marker($source, $i);
        if (!$inFence && $fence !== '') {
            $inFence = true;
            $fenceMarker = $fence;
            $out .= $fence;
            $i += 3;
            continue;
        }
        if ($inFence && $fence !== '' && $fence === $fenceMarker) {
            $inFence = false;
            $fenceMarker = '';
            $out .= $fence;
            $i += 3;
            continue;
        }
        $ch = $source[$i];
        if (!$inFence) {
            if ($ch === '<') {
                $next = $source[$i + 1] ?? '';
                if ($next === '!' || $next === '/' || ctype_alpha($next)) {
                    $inTag = true;
                    $out .= $ch;
                    $i++;
                    continue;
                }
            }
            if ($inTag) {
                $out .= $ch;
                if ($ch === '>') {
                    $inTag = false;
                }
                $i++;
                continue;
            }
            if ($ch === '`') {
                $inInline = !$inInline;
                $out .= $ch;
                $i++;
                continue;
            }
            if ($ch === "\n") {
                $inInline = false;
            }
            if (!$inInline && $ch === ':') {
                $end = strpos($source, ':', $i + 1);
                if ($end !== false && $end > $i + 1) {
                    $token = substr($source, $i, $end - $i + 1);
                    $name = sanitize_emoji_token_name($token);
                    if ($name !== '') {
                        $src = resolve_custom_emoji_src($name, $shareId, $assetBasePath);
                        if ($src !== '') {
                            $out .= '![](<';
                            $out .= $src;
                            $out .= '>)';
                            $nextName = get_emoji_token_name_at($source, $end + 1);
                            if ($nextName !== '') {
                                $nextSrc = resolve_custom_emoji_src($nextName, $shareId, $assetBasePath);
                                if ($nextSrc !== '') {
                                    $out .= ' ';
                                }
                            }
                            $i = $end + 1;
                            continue;
                        }
                    }
                    $out .= $token;
                    $i = $end + 1;
                    continue;
                }
            }
        }
        $out .= $ch;
        $i++;
    }
    return $out;
}

function insert_adjacent_emoji_image_spacing(string $markdown): string {
    $source = (string)$markdown;
    if ($source === '') {
        return $source;
    }
    return preg_replace(
        '/(!\[[^\]]*]\((?:<)?[^)\s]*emojis\/[^)\s>]+(?:>)?\))(?=!\[[^\]]*]\((?:<)?[^)\s]*emojis\/)/',
        '$1 ',
        $source,
    ) ?? $source;
}

function strip_duplicate_title_heading(string $markdown, string $title): string {
    $title = trim($title);
    if ($title === '') {
        return $markdown;
    }
    $lines = preg_split("/\r\n|\r|\n/", $markdown);
    if (!is_array($lines)) {
        return $markdown;
    }
    $count = count($lines);
    $idx = 0;
    while ($idx < $count && trim($lines[$idx]) === '') {
        $idx++;
    }
    if ($idx >= $count) {
        return $markdown;
    }
    $line = trim($lines[$idx]);
    $next = $idx + 1 < $count ? trim($lines[$idx + 1]) : '';
    $headingText = '';
    $removeLines = 0;
    if (preg_match('/^#{1,6}\s+(.*)$/', $line, $match)) {
        $headingText = trim($match[1]);
        $removeLines = 1;
    } elseif ($line === $title && $next !== '' && preg_match('/^=+$/', $next)) {
        $headingText = $line;
        $removeLines = 2;
    }
    if ($headingText === '' || $headingText !== $title) {
        return $markdown;
    }
    $start = $idx;
    $end = $idx + $removeLines;
    while ($end < $count && trim($lines[$end]) === '') {
        $end++;
    }
    array_splice($lines, $start, $end - $start);
    return implode("\n", $lines);
}

function render_markdown(string $markdown): string {
    static $parser = null;
    if (!$parser) {
        $parser = new Parsedown();
        if (method_exists($parser, 'setSafeMode')) {
            $parser->setSafeMode(false);
        }
    }
    return $parser->text($markdown);
}

function share_requires_password(array $share): bool {
    return !empty($share['password_hash']);
}

function share_is_expired(array $share): bool {
    if (empty($share['expires_at'])) {
        return false;
    }
    return time() > (int)$share['expires_at'];
}

function share_access_granted(int $shareId): bool {
    return !empty($_SESSION['share_access'][$shareId]);
}

function grant_share_access(int $shareId): void {
    if (!isset($_SESSION['share_access'])) {
        $_SESSION['share_access'] = [];
    }
    $_SESSION['share_access'][$shareId] = true;
}

function share_visitor_limit(array $share): int {
    return max(0, (int)($share['visitor_limit'] ?? 0));
}

function seed_share_visitors_from_logs(int $shareId): void {
    if ($shareId <= 0) {
        return;
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM share_visitors WHERE share_id = :sid');
    $stmt->execute([':sid' => $shareId]);
    if ((int)$stmt->fetchColumn() > 0) {
        return;
    }
    $pdo->prepare('INSERT OR IGNORE INTO share_visitors (share_id, visitor_id, created_at)
        SELECT share_id, visitor_id, MIN(created_at) FROM share_access_logs
        WHERE share_id = :sid AND visitor_id IS NOT NULL AND visitor_id != ""
        GROUP BY visitor_id')->execute([':sid' => $shareId]);
}

function share_visitor_count(int $shareId): int {
    if ($shareId <= 0) {
        return 0;
    }
    seed_share_visitors_from_logs($shareId);
    $pdo = db();
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM share_visitors WHERE share_id = :sid');
    $stmt->execute([':sid' => $shareId]);
    return (int)$stmt->fetchColumn();
}

function share_visitor_limit_reached(array $share): bool {
    $limit = share_visitor_limit($share);
    if ($limit <= 0) {
        return false;
    }
    $shareId = (int)($share['id'] ?? 0);
    if ($shareId <= 0) {
        return false;
    }
    seed_share_visitors_from_logs($shareId);
    $visitorId = get_visitor_id();
    $pdo = db();
    if ($visitorId !== '') {
        $stmt = $pdo->prepare('SELECT 1 FROM share_visitors WHERE share_id = :sid AND visitor_id = :vid LIMIT 1');
        $stmt->execute([
            ':sid' => $shareId,
            ':vid' => $visitorId,
        ]);
        if ($stmt->fetchColumn()) {
            return false;
        }
    }
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM share_visitors WHERE share_id = :sid');
    $stmt->execute([':sid' => $shareId]);
    return (int)$stmt->fetchColumn() >= $limit;
}

function register_share_visitor(int $shareId, string $visitorId): void {
    if ($shareId <= 0 || $visitorId === '') {
        return;
    }
    $pdo = db();
    $pdo->prepare('INSERT OR IGNORE INTO share_visitors (share_id, visitor_id, created_at)
        VALUES (:sid, :vid, :created_at)')->execute([
        ':sid' => $shareId,
        ':vid' => $visitorId,
        ':created_at' => now(),
    ]);
}

function build_doc_tree(array $docs, ?string $activeId = null): array {
    $useParent = false;
    foreach ($docs as $doc) {
        if (isset($doc['parent_id']) && trim((string)$doc['parent_id']) !== '') {
            $useParent = true;
            break;
        }
    }
    if ($useParent) {
        $nodes = [];
        foreach ($docs as $docIndex => $doc) {
            $docId = trim((string)($doc['doc_id'] ?? ''));
            if ($docId === '') {
                continue;
            }
            $nodes[$docId] = [
                'title' => (string)($doc['title'] ?? $docId),
                'children' => [],
                'doc' => $doc,
                'contains_active' => false,
                'order' => is_numeric($doc['sort_index'] ?? null) ? (float)$doc['sort_index'] : $docIndex,
                'order_index' => $docIndex,
            ];
        }
        $tree = [];
        foreach ($nodes as $docId => &$node) {
            $parentId = trim((string)($node['doc']['parent_id'] ?? ''));
            if ($parentId !== '' && isset($nodes[$parentId]) && $parentId !== $docId) {
                $nodes[$parentId]['children'][$docId] =& $node;
            } else {
                $tree[$docId] =& $node;
            }
        }
        unset($node);
        mark_doc_tree_active($tree, $activeId);
        sort_doc_tree($tree);
        return $tree;
    }
    $root = ['children' => []];
    foreach ($docs as $docIndex => $doc) {
        $hpath = trim((string)($doc['hpath'] ?? ''), '/');
        $parts = $hpath !== '' ? array_values(array_filter(explode('/', $hpath))) : [];
        if (empty($parts)) {
            $parts = [trim((string)($doc['title'] ?? '')) ?: trim((string)($doc['doc_id'] ?? ''))];
        }
        $docOrder = isset($doc['sort_order']) ? (int)$doc['sort_order'] : $docIndex;
        $docOrderIndex = $docIndex;
        $node =& $root['children'];
        foreach ($parts as $idx => $part) {
            $isLast = $idx === count($parts) - 1;
            $key = $part;
            if (!isset($node[$key])) {
                $node[$key] = [
                    'title' => $part,
                    'children' => [],
                    'doc' => null,
                    'contains_active' => false,
                    'order' => $docOrder,
                    'order_index' => $docOrderIndex,
                ];
            } else {
                $existingOrder = $node[$key]['order'] ?? $docOrder;
                $existingIndex = $node[$key]['order_index'] ?? $docOrderIndex;
                if ($docOrder < $existingOrder || ($docOrder === $existingOrder && $docOrderIndex < $existingIndex)) {
                    $node[$key]['order'] = $docOrder;
                    $node[$key]['order_index'] = $docOrderIndex;
                }
            }
            if ($isLast) {
                $node[$key]['doc'] = $doc;
                $node[$key]['order'] = min($node[$key]['order'] ?? $docOrder, $docOrder);
                $node[$key]['order_index'] = min($node[$key]['order_index'] ?? $docOrderIndex, $docOrderIndex);
            }
            $node =& $node[$key]['children'];
        }
    }
    $tree = $root['children'];
    mark_doc_tree_active($tree, $activeId);
    sort_doc_tree($tree);
    return $tree;
}

function mark_doc_tree_active(array &$nodes, ?string $activeId = null): bool {
    $hasActive = false;
    foreach ($nodes as &$node) {
        $nodeHas = false;
        $doc = $node['doc'] ?? null;
        if ($activeId && $doc && (string)$doc['doc_id'] === (string)$activeId) {
            $nodeHas = true;
        }
        if (!empty($node['children'])) {
            $childHas = mark_doc_tree_active($node['children'], $activeId);
            $nodeHas = $nodeHas || $childHas;
        }
        $node['contains_active'] = $nodeHas;
        if ($nodeHas) {
            $hasActive = true;
        }
    }
    unset($node);
    return $hasActive;
}

function sort_doc_tree(array &$nodes): void {
    foreach ($nodes as &$node) {
        if (!empty($node['children'])) {
            sort_doc_tree($node['children']);
        }
    }
    unset($node);
    uasort($nodes, function ($a, $b) {
        $orderA = $a['order'] ?? PHP_INT_MAX;
        $orderB = $b['order'] ?? PHP_INT_MAX;
        if ($orderA === $orderB) {
            $idxA = $a['order_index'] ?? PHP_INT_MAX;
            $idxB = $b['order_index'] ?? PHP_INT_MAX;
            if ($idxA === $idxB) {
                return strcmp((string)($a['title'] ?? ''), (string)($b['title'] ?? ''));
            }
            return $idxA <=> $idxB;
        }
        return $orderA <=> $orderB;
    });
}

function decode_hex_emoji_string(string $value): string {
    $raw = trim($value);
    if ($raw === '') {
        return $raw;
    }
    $raw = preg_replace('/^u\+/i', '', $raw);
    $raw = str_replace(' ', '', $raw);
    if (!preg_match('/^(?:0x)?[0-9a-f]{4,6}(?:-(?:0x)?[0-9a-f]{4,6})*$/i', $raw)) {
        return $value;
    }
    $parts = explode('-', strtolower($raw));
    $out = '';
    foreach ($parts as $part) {
        $part = preg_replace('/^0x/', '', $part);
        if ($part === '') {
            continue;
        }
        $out .= html_entity_decode('&#x' . $part . ';', ENT_NOQUOTES, 'UTF-8');
    }
    return $out !== '' ? $out : $value;
}

function normalize_doc_icon_value($value): string {
    if ($value === null) {
        return '';
    }
    if (is_string($value)) {
        $trimmed = trim($value);
        if ($trimmed === '') {
            return '';
        }
        if ((str_starts_with($trimmed, '{') && str_ends_with($trimmed, '}')) ||
            (str_starts_with($trimmed, '[') && str_ends_with($trimmed, ']'))
        ) {
            $decoded = json_decode($trimmed, true);
            if (json_last_error() === JSON_ERROR_NONE && $decoded !== null) {
                return normalize_doc_icon_value($decoded);
            }
        }
        return decode_hex_emoji_string($trimmed);
    }
    if (is_numeric($value)) {
        return decode_hex_emoji_string((string)$value);
    }
    if (is_object($value)) {
        $value = (array)$value;
    }
    if (is_array($value)) {
        $keys = ['icon', 'value', 'emoji', 'iconEmoji', 'iconValue', 'path', 'file', 'asset', 'assetPath', 'src', 'url'];
        foreach ($keys as $key) {
            if (array_key_exists($key, $value)) {
                $candidate = normalize_doc_icon_value($value[$key]);
                if ($candidate !== '') {
                    return $candidate;
                }
            }
        }
        foreach ($value as $item) {
            $candidate = normalize_doc_icon_value($item);
            if ($candidate !== '') {
                return $candidate;
            }
        }
    }
    return '';
}

function is_doc_icon_image_value(string $icon): bool {
    if ($icon === '') {
        return false;
    }
    if (preg_match('/^data:image\//i', $icon)) {
        return true;
    }
    if (preg_match('/^https?:\/\//i', $icon)) {
        return true;
    }
    if (strpos($icon, '/') !== false || preg_match('/\.(svg|png|jpe?g|gif|webp|bmp)$/i', $icon)) {
        return true;
    }
    return false;
}

function build_doc_icon_src(string $icon, string $assetBasePath): string {
    if ($icon === '') {
        return '';
    }
    if (preg_match('/^data:image\//i', $icon) || preg_match('/^https?:\/\//i', $icon)) {
        return $icon;
    }
    $path = sanitize_asset_path($icon);
    if ($path === '') {
        return '';
    }
    $prefix = $assetBasePath;
    if ($prefix !== '' && substr($prefix, -1) !== '/') {
        $prefix .= '/';
    }
    return $prefix . $path;
}

function render_doc_tree_icon(?array $doc, string $assetBasePath): string {
    $icon = $doc ? normalize_doc_icon_value($doc['icon'] ?? '') : '';
    if ($icon !== '' && is_doc_icon_image_value($icon)) {
        $src = build_doc_icon_src($icon, $assetBasePath);
        if ($src !== '') {
            return '<img class="kb-tree-icon kb-tree-icon--image" src="' . htmlspecialchars($src) . '" alt="">';
        }
    }
    if ($icon !== '' && !is_doc_icon_image_value($icon)) {
        return '<span class="kb-tree-icon kb-tree-icon--emoji">' . htmlspecialchars($icon) . '</span>';
    }
    return '';
}

function render_doc_tree(array $nodes, string $slug, ?string $activeId = null, int $level = 0, string $path = '', string $assetBasePath = ''): string {
    if (empty($nodes)) {
        return '';
    }
    $html = '<ul class="kb-tree kb-tree-children" data-level="' . $level . '">';
    foreach ($nodes as $node) {
        $doc = $node['doc'] ?? null;
        $hasChildren = !empty($node['children']);
        $isActive = $doc && $activeId && (string)$doc['doc_id'] === (string)$activeId;
        $shouldOpen = false;
        $nodeLabel = $doc ? (string)($doc['doc_id'] ?? '') : (string)($node['title'] ?? '');
        $pathKey = trim($path . '/' . $nodeLabel, '/');
        $nodeKey = $doc ? ('doc:' . $nodeLabel) : ('folder:' . $pathKey);
        $nodeClass = 'kb-tree-node';
        if ($hasChildren) {
            $nodeClass .= $shouldOpen ? ' is-open' : ' is-collapsed';
        }
        $html .= '<li class="' . $nodeClass . '" data-tree-key="' . htmlspecialchars($nodeKey) . '">';
        $html .= '<div class="kb-tree-row">';
        if ($hasChildren) {
            $html .= '<button class="kb-tree-toggle" type="button" aria-expanded="' . ($shouldOpen ? 'true' : 'false') . '">';
            $html .= '<svg class="kb-tree-toggle-icon kb-tree-toggle-icon--collapsed" viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-arrow-collapsed"></use></svg>';
            $html .= '<svg class="kb-tree-toggle-icon kb-tree-toggle-icon--open" viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-arrow-expanded"></use></svg>';
            $html .= '</button>';
        } else {
            $html .= '<span class="kb-tree-spacer"></span>';
        }
        if ($doc) {
            $docId = (string)$doc['doc_id'];
            $docTitle = htmlspecialchars($doc['title'] ?? $docId);
            $docPath = base_path() . '/s/' . $slug . '/' . rawurlencode($docId);
            $activeClass = $isActive ? ' is-active' : '';
            $docAttrs = ' href="' . $docPath . '" data-doc-id="' . htmlspecialchars($docId) . '" data-share-nav="doc"';
            $html .= '<a class="kb-tree-item' . $activeClass . '"' . $docAttrs . '>';
            $html .= render_doc_tree_icon($doc, $assetBasePath);
            $html .= '<span class="kb-tree-label">' . $docTitle . '</span></a>';
        } else {
            $html .= '<div class="kb-tree-folder">';
            $html .= render_doc_tree_icon(null, $assetBasePath);
            $html .= '<span class="kb-tree-label">' . htmlspecialchars((string)$node['title']) . '</span></div>';
        }
        $html .= '</div>';
        if ($hasChildren) {
            $html .= render_doc_tree($node['children'], $slug, $activeId, $level + 1, $pathKey, $assetBasePath);
        }
        $html .= '</li>';
    }
    $html .= '</ul>';
    return $html;
}

function build_breadcrumbs(string $hpath): array {
    $trimmed = trim($hpath, '/');
    if ($trimmed === '') {
        return [];
    }
    return array_values(array_filter(explode('/', $trimmed)));
}

function is_share_partial_request(): bool {
    if (!empty($_GET['partial']) && (string)$_GET['partial'] === '1') {
        return true;
    }
    if (!empty($_SERVER['HTTP_X_SPS_PARTIAL']) && (string)$_SERVER['HTTP_X_SPS_PARTIAL'] === '1') {
        return true;
    }
    return false;
}

function route_share(string $slug, ?string $docId = null): void {
    $share = find_share_by_slug($slug);
    if (!$share) {
        http_response_code(404);
        echo '分享不存在。';
        exit;
    }
    $shareId = (int)$share['id'];
    $viewer = current_user();
    $shareTitleRaw = (string)$share['title'];
    $shareTitle = htmlspecialchars($shareTitleRaw);
    $redirectPath = '/s/' . $slug . ($docId ? '/' . rawurlencode($docId) : '');
    $isPartial = is_share_partial_request();

    if (share_is_expired($share)) {
        $content = '<div class="share-shell share-shell--single">';
        $content .= '<div class="share-content">';
        $content .= '<div class="share-header"><h1>' . $shareTitle . '</h1></div>';
        $content .= '<div class="share-empty">该分享已过期，内容不可见。</div>';
        $content .= '</div></div>';
        render_page($shareTitleRaw, $content, null, '', ['layout' => 'share']);
        return;
    }

    if (share_visitor_limit_reached($share)) {
        $content = '<div class="share-shell share-shell--single">';
        $content .= '<div class="share-content">';
        $content .= '<div class="share-header"><h1>' . $shareTitle . '</h1></div>';
        $content .= '<div class="share-empty">访客数已达上限，分享已关闭。</div>';
        $content .= '</div></div>';
        render_page($shareTitleRaw, $content, null, '', ['layout' => 'share']);
        return;
    }

    if (share_requires_password($share) && !share_access_granted($shareId)) {
        $error = '';
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $input = trim((string)($_POST['share_password'] ?? ''));
            if ($input !== '' && password_verify($input, (string)$share['password_hash'])) {
                grant_share_access($shareId);
                redirect($redirectPath);
            }
            $error = '访问密码错误';
        }
        $content = '<div class="share-shell share-shell--single">';
        $content .= '<div class="share-content">';
        $content .= '<div class="share-header"><h1>' . $shareTitle . '</h1></div>';
        $content .= '<div class="share-gate">';
        $content .= '<div class="share-gate-note">该分享设置了访问密码</div>';
        if ($error) {
            $content .= '<div class="alert error">' . htmlspecialchars($error) . '</div>';
        }
        $content .= '<form method="post" class="share-gate-form">';
        $content .= '<input class="input" type="password" name="share_password" placeholder="请输入访问密码" required>';
        $content .= '<button class="button primary" type="submit">验证</button>';
        $content .= '</form></div></div></div>';
        render_page($shareTitleRaw, $content, null, '', ['layout' => 'share']);
        return;
    }

    if (share_visitor_limit($share) > 0) {
        register_share_visitor($shareId, get_visitor_id());
    }
    $pdo = db();
    $pdo->prepare('UPDATE shares SET access_count = access_count + 1 WHERE id = :id')
        ->execute([':id' => $shareId]);
    $share['access_count'] = (int)($share['access_count'] ?? 0) + 1;
    $stmt = $pdo->prepare('SELECT * FROM share_docs WHERE share_id = :sid ORDER BY sort_order ASC, id ASC');
    $stmt->execute([':sid' => $shareId]);
    $docs = $stmt->fetchAll(PDO::FETCH_ASSOC);
    if (empty($docs)) {
        http_response_code(404);
        echo '文档不存在。';
        exit;
    }

    $assetBasePath = base_path() . '/uploads/shares/' . $shareId . '/';

    if ($share['type'] === 'doc') {
        $hasMultipleDocs = count($docs) > 1;
        $activeDocId = $docId ?: (string)($share['doc_id'] ?? ($docs[0]['doc_id'] ?? ''));
        if ($hasMultipleDocs) {
            $doc = null;
            foreach ($docs as $item) {
                if ((string)($item['doc_id'] ?? '') === (string)$activeDocId) {
                    $doc = $item;
                    break;
                }
            }
            if (!$doc && !$docId && !empty($docs)) {
                $doc = $docs[0];
                $activeDocId = (string)($doc['doc_id'] ?? '');
            }
            if (!$doc) {
                http_response_code(404);
                echo '文档不存在。';
                exit;
            }
            $docTitleRaw = trim((string)($doc['title'] ?? '')) ?: $shareTitleRaw;
            $docTitle = htmlspecialchars($docTitleRaw);
            $front = extract_front_matter((string)$doc['markdown']);
            $markdown = rewrite_asset_links((string)$front['body'], $assetBasePath);
            $markdown = strip_duplicate_title_heading($markdown, $docTitleRaw);
            $markdown = replace_custom_emoji_tokens($markdown, (int)$shareId, $assetBasePath);
            $markdown = insert_adjacent_emoji_image_spacing($markdown);
            $reportTrigger = render_share_report_trigger($share);
            $shareMetaHtml = render_share_stats($share, $reportTrigger);
            record_share_access($share, (string)($doc['doc_id'] ?? ''), $docTitleRaw);
            $commentHtml = render_share_comments($share, $viewer, (string)$activeDocId);
            $reportModalHtml = render_share_report_form($share, $viewer, (string)$activeDocId);
            $treeHtml = render_doc_tree(build_doc_tree($docs, $activeDocId), $slug, $activeDocId, 0, '', $assetBasePath);
            $sidebar = '<aside class="kb-sidebar" data-share-sidebar data-share-slug="' . htmlspecialchars($slug) . '">';
            $sidebar .= '<div class="kb-side-tabs" data-share-tabs data-share-default="tree">';
            $sidebar .= '<button class="kb-side-tab is-active" type="button" data-share-tab="tree">文档树</button>';
            $sidebar .= '<button class="kb-side-tab" type="button" data-share-tab="toc">目录</button>';
            $sidebar .= '<div class="kb-side-actions" data-share-tree-actions>';
            $sidebar .= '<button class="kb-side-action" type="button" data-tree-collapse title="折叠所有" aria-label="折叠所有"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-collapse-all"></use></svg></button>';
            $sidebar .= '<button class="kb-side-action" type="button" data-tree-expand title="展开所有" aria-label="展开所有"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-expand-all"></use></svg></button>';
            $sidebar .= '</div>';
            $sidebar .= '</div>';
            $sidebar .= '<div class="kb-side-panel" data-share-panel="tree">';
            $sidebar .= '<div class="kb-side-body">' . $treeHtml . '</div>';
            $sidebar .= '</div>';
            $sidebar .= '<div class="kb-side-panel" data-share-panel="toc" data-share-toc="doc" hidden>';
            $sidebar .= '<div class="kb-side-body share-toc-body"></div>';
            $sidebar .= '</div>';
            $sidebar .= '</aside>';
            $base = base_path();
            $crumbs = build_breadcrumbs((string)($doc['hpath'] ?? ''));
            if (!empty($crumbs)) {
                array_pop($crumbs);
            }
            if ($shareTitleRaw !== '' && !empty($crumbs)) {
                while (!empty($crumbs) && $crumbs[0] === $shareTitleRaw) {
                    array_shift($crumbs);
                }
            }
            $filteredCrumbs = [];
            $prevCrumb = null;
            foreach ($crumbs as $crumb) {
                if ($crumb === $prevCrumb) {
                    continue;
                }
                $filteredCrumbs[] = $crumb;
                $prevCrumb = $crumb;
            }
            $crumbs = $filteredCrumbs;
            $breadcrumbsHtml = '<div class="kb-breadcrumbs"><a class="kb-back" href="' . $base . '/s/' . $slug . '" data-doc-id="" data-share-nav="doc">' . htmlspecialchars($shareTitleRaw) . '</a>';
            foreach ($crumbs as $crumb) {
                $breadcrumbsHtml .= '<span>' . htmlspecialchars($crumb) . '</span>';
            }
            $breadcrumbsHtml .= '</div>';
            $mainHtml = '<div class="kb-main">';
            $mainHtml .= '<div class="share-article" data-share-view="preview">';
            $mainHtml .= '<div class="kb-header">' . $breadcrumbsHtml;
            $mainHtml .= '<div class="kb-title-row">';
            $mainHtml .= '<h1 class="kb-title">' . $docTitle . '</h1>';
            $mainHtml .= '<button class="button ghost share-view-toggle" type="button" data-share-toggle aria-pressed="false">源码</button>';
            $mainHtml .= '</div>';
            $mainHtml .= $shareMetaHtml;
            $mainHtml .= '</div>';
            $mainHtml .= '<div class="markdown-body" data-md-id="doc">' . render_markdown($markdown) . '</div>';
            $mainHtml .= '<textarea class="markdown-source" data-md-id="doc" readonly spellcheck="false" aria-label="Markdown 源码">' . htmlspecialchars($markdown) . '</textarea>';
            $mainHtml .= $commentHtml;
            $mainHtml .= $reportModalHtml;
            $mainHtml .= '</div></div>';
            if ($isPartial) {
                api_response(200, [
                    'title' => $docTitleRaw,
                    'docId' => $activeDocId,
                    'html' => $mainHtml,
                ]);
            }
            $content = '<div class="share-shell share-shell--notebook" data-share-doc-id="' . htmlspecialchars($activeDocId) . '">';
            $content .= $sidebar;
            $content .= $mainHtml;
            $content .= '</div>';
            render_page($docTitleRaw, $content, null, '', ['layout' => 'share', 'markdown' => true]);
            return;
        }

        $doc = $docs[0];
        $docTitleRaw = trim((string)($doc['title'] ?? '')) ?: $shareTitleRaw;
        $docTitle = htmlspecialchars($docTitleRaw);
        $front = extract_front_matter((string)$doc['markdown']);
        $markdown = rewrite_asset_links((string)$front['body'], $assetBasePath);
        $markdown = strip_duplicate_title_heading($markdown, $docTitleRaw);
        $markdown = replace_custom_emoji_tokens($markdown, (int)$shareId, $assetBasePath);
        $markdown = insert_adjacent_emoji_image_spacing($markdown);
        $reportTrigger = render_share_report_trigger($share);
        $shareMetaHtml = render_share_stats($share, $reportTrigger);
        record_share_access($share, (string)($doc['doc_id'] ?? ''), $docTitleRaw);
        $commentHtml = render_share_comments($share, $viewer, null);
        $reportModalHtml = render_share_report_form($share, $viewer, null);
        $sidebar = '<aside class="kb-sidebar" data-share-sidebar data-share-slug="' . htmlspecialchars($slug) . '">';
        $sidebar .= '<div class="kb-side-tabs" data-share-tabs data-share-default="toc">';
        $sidebar .= '<button class="kb-side-tab is-active" type="button" data-share-tab="toc">目录</button>';
        $sidebar .= '</div>';
        $sidebar .= '<div class="kb-side-panel" data-share-panel="toc" data-share-toc="doc">';
        $sidebar .= '<div class="kb-side-body share-toc-body"></div>';
        $sidebar .= '</div>';
        $sidebar .= '</aside>';
        $content = '<div class="share-shell share-shell--notebook">';
        $content .= $sidebar;
        $content .= '<div class="kb-main">';
        $content .= '<div class="share-article" data-share-view="preview">';
        $content .= '<div class="kb-header">';
        $content .= '<div class="kb-title-row">';
        $content .= '<h1 class="kb-title">' . $docTitle . '</h1>';
        $content .= '<button class="button ghost share-view-toggle" type="button" data-share-toggle aria-pressed="false">源码</button>';
        $content .= '</div>';
        $content .= $shareMetaHtml;
        $content .= '</div>';
        $content .= '<div class="markdown-body" data-md-id="doc">' . render_markdown($markdown) . '</div>';
        $content .= '<textarea class="markdown-source" data-md-id="doc" readonly spellcheck="false" aria-label="Markdown 源码">' . htmlspecialchars($markdown) . '</textarea>';
        $content .= $commentHtml;
        $content .= $reportModalHtml;
        $content .= '</div></div></div>';
        render_page($docTitleRaw, $content, null, '', ['layout' => 'share', 'markdown' => true]);
    }

    if ($share['type'] === 'notebook') {
        $treeHtml = render_doc_tree(build_doc_tree($docs, $docId), $slug, $docId, 0, '', $assetBasePath);
        $sidebar = '<aside class="kb-sidebar" data-share-sidebar data-share-slug="' . htmlspecialchars($slug) . '">';
        $sidebar .= '<div class="kb-side-tabs" data-share-tabs data-share-default="tree">';
        $sidebar .= '<button class="kb-side-tab is-active" type="button" data-share-tab="tree">文档树</button>';
        $sidebar .= '<button class="kb-side-tab" type="button" data-share-tab="toc">目录</button>';
        $sidebar .= '<div class="kb-side-actions" data-share-tree-actions>';
        $sidebar .= '<button class="kb-side-action" type="button" data-tree-collapse title="折叠所有" aria-label="折叠所有"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-collapse-all"></use></svg></button>';
        $sidebar .= '<button class="kb-side-action" type="button" data-tree-expand title="展开所有" aria-label="展开所有"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#sps-tree-expand-all"></use></svg></button>';
        $sidebar .= '</div>';
        $sidebar .= '</div>';
        $sidebar .= '<div class="kb-side-panel" data-share-panel="tree">';
        $sidebar .= '<div class="kb-side-body">' . $treeHtml . '</div>';
        $sidebar .= '</div>';
        $sidebar .= '<div class="kb-side-panel" data-share-panel="toc" data-share-toc="doc" hidden>';
        $sidebar .= '<div class="kb-side-body share-toc-body"></div>';
        $sidebar .= '</div>';
        $sidebar .= '</aside>';
        $base = base_path();

        if ($docId) {
            $doc = null;
            foreach ($docs as $item) {
                if ((string)$item['doc_id'] === (string)$docId) {
                    $doc = $item;
                    break;
                }
            }
            if (!$doc) {
                http_response_code(404);
                echo '文档不存在。';
                exit;
            }
            $docTitleRaw = trim((string)($doc['title'] ?? '')) ?: $shareTitleRaw;
            $docTitle = htmlspecialchars($docTitleRaw);
            $front = extract_front_matter((string)$doc['markdown']);
            $markdown = rewrite_asset_links((string)$front['body'], $assetBasePath);
            $markdown = strip_duplicate_title_heading($markdown, $docTitleRaw);
            $markdown = replace_custom_emoji_tokens($markdown, (int)$shareId, $assetBasePath);
            $markdown = insert_adjacent_emoji_image_spacing($markdown);
            $reportTrigger = render_share_report_trigger($share);
            $shareMetaHtml = render_share_stats($share, $reportTrigger);
            record_share_access($share, (string)($doc['doc_id'] ?? ''), $docTitleRaw);
            $commentHtml = render_share_comments($share, $viewer, (string)$docId);
            $reportModalHtml = render_share_report_form($share, $viewer, (string)$docId);
            $crumbs = build_breadcrumbs((string)($doc['hpath'] ?? ''));
            if (!empty($crumbs)) {
                array_pop($crumbs);
            }
            $breadcrumbsHtml = '<div class="kb-breadcrumbs"><a class="kb-back" href="' . $base . '/s/' . $slug . '" data-doc-id="" data-share-nav="doc">目录</a>';
            foreach ($crumbs as $crumb) {
                $breadcrumbsHtml .= '<span>' . htmlspecialchars($crumb) . '</span>';
            }
            $breadcrumbsHtml .= '</div>';
            $mainHtml = '<div class="kb-main">';
            $mainHtml .= '<div class="share-article" data-share-view="preview">';
            $mainHtml .= '<div class="kb-header">' . $breadcrumbsHtml;
            $mainHtml .= '<div class="kb-title-row">';
            $mainHtml .= '<h1 class="kb-title">' . $docTitle . '</h1>';
            $mainHtml .= '<button class="button ghost share-view-toggle" type="button" data-share-toggle aria-pressed="false">源码</button>';
            $mainHtml .= '</div>';
            $mainHtml .= $shareMetaHtml;
            $mainHtml .= '</div>';
            $mainHtml .= '<div class="markdown-body" data-md-id="doc">' . render_markdown($markdown) . '</div>';
            $mainHtml .= '<textarea class="markdown-source" data-md-id="doc" readonly spellcheck="false" aria-label="Markdown 源码">' . htmlspecialchars($markdown) . '</textarea>';
            $mainHtml .= $commentHtml;
            $mainHtml .= $reportModalHtml;
            $mainHtml .= '</div></div>';
            if ($isPartial) {
                api_response(200, [
                    'title' => $docTitleRaw,
                    'docId' => $docId,
                    'html' => $mainHtml,
                ]);
            }
            $content = '<div class="share-shell share-shell--notebook" data-share-doc-id="' . htmlspecialchars((string)$docId) . '">';
            $content .= $sidebar;
            $content .= $mainHtml;
            $content .= '</div>';
            render_page($docTitleRaw, $content, null, '', ['layout' => 'share', 'markdown' => true]);
        }

        if (!$docId) {
            $mainHtml = '<div class="kb-main"><div class="share-empty">请先在文档树里面先打开一个文档</div></div>';
            if ($isPartial) {
                api_response(200, [
                    'title' => $shareTitleRaw,
                    'docId' => '',
                    'html' => $mainHtml,
                ]);
            }
            $content = '<div class="share-shell share-shell--notebook" data-share-doc-id="">';
            $content .= $sidebar;
            $content .= $mainHtml;
            $content .= '</div>';
            record_share_access($share, null, $shareTitleRaw);
            render_page($shareTitleRaw, $content, null, '', ['layout' => 'share']);
        }

        $rows = '';
        foreach ($docs as $doc) {
            $docTitleRaw = trim((string)($doc['title'] ?? '')) ?: (string)$doc['doc_id'];
            $docTitle = htmlspecialchars($docTitleRaw);
            $docPath = $base . '/s/' . $slug . '/' . rawurlencode((string)$doc['doc_id']);
            $hPath = trim((string)($doc['hpath'] ?? ''), '/');
            $pathLabel = $hPath !== '' ? $hPath : '/';
            $front = extract_front_matter((string)$doc['markdown']);
            $meta = (array)$front['meta'];
            $updatedRaw = $meta['lastmod'] ?? $meta['updated'] ?? $meta['modified'] ?? '';
            $updated = $updatedRaw ? format_meta_date((string)$updatedRaw) : '';
            $rows .= '<a class="kb-dir-row" href="' . $docPath . '" data-doc-id="' . htmlspecialchars((string)$doc['doc_id']) . '" data-share-nav="doc">';
            $rows .= '<div class="kb-dir-title">' . $docTitle . '</div>';
            $rows .= '<div class="kb-dir-path">' . htmlspecialchars($pathLabel) . '</div>';
            $rows .= '<div class="kb-dir-time">' . htmlspecialchars($updated) . '</div>';
            $rows .= '</a>';
        }
        if ($rows === '') {
            $rows = '<div class="share-empty">暂无文档。</div>';
        } else {
            $rows = '<div class="kb-directory"><div class="kb-dir-head"><div>标题</div><div>路径</div><div>更新</div></div>' . $rows . '</div>';
        }
        $reportTrigger = render_share_report_trigger($share);
        $reportModalHtml = render_share_report_form($share, $viewer, null);
        $content = '<div class="share-shell share-shell--notebook">';
        $content .= $sidebar;
        $content .= '<div class="kb-main">';
        $content .= '<div class="kb-header">';
        $content .= '<div class="kb-breadcrumbs"><span>目录</span></div>';
        $content .= '<div class="kb-title-row">';
        $content .= '<h1 class="kb-title">' . $shareTitle . '</h1>';
        $content .= '</div>';
        $content .= '<div class="kb-meta"><span class="kb-chip"><strong>文档</strong> ' . count($docs) . ' 篇</span></div>';
        $content .= render_share_stats($share, $reportTrigger);
        $content .= '</div>';
        $content .= $rows;
        $content .= $reportModalHtml;
        $content .= '</div></div>';
        render_page($shareTitleRaw, $content, null, '', ['layout' => 'share']);
    }

    http_response_code(404);
    echo '分享不存在。';
    exit;
}
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';
$base = base_path();
if ($base && strpos($path, $base) === 0) {
    $path = substr($path, strlen($base));
    if ($path === '') {
        $path = '/';
    }
}

if ($path === '/api/instances/heartbeat') {
    handle_instance_heartbeat();
}

if ($path === '/api/instances/stats') {
    handle_instance_stats();
}

if (strpos($path, '/api/v1/') === 0) {
    handle_api($path);
}

if (preg_match('#^/s/([a-zA-Z0-9_-]+)/comment$#', $path, $matches) && $_SERVER['REQUEST_METHOD'] === 'POST') {
    handle_share_comment_submit($matches[1]);
}

if (preg_match('#^/s/([a-zA-Z0-9_-]+)/comment/upload$#', $path, $matches) && $_SERVER['REQUEST_METHOD'] === 'POST') {
    handle_share_comment_upload($matches[1]);
}

if (preg_match('#^/s/([a-zA-Z0-9_-]+)/comment/edit$#', $path, $matches) && $_SERVER['REQUEST_METHOD'] === 'POST') {
    handle_share_comment_edit($matches[1]);
}

if (preg_match('#^/s/([a-zA-Z0-9_-]+)/comment/delete$#', $path, $matches) && $_SERVER['REQUEST_METHOD'] === 'POST') {
    handle_share_comment_delete($matches[1]);
}

if (preg_match('#^/s/([a-zA-Z0-9_-]+)/report$#', $path, $matches) && $_SERVER['REQUEST_METHOD'] === 'POST') {
    handle_share_report_submit($matches[1]);
}

if (preg_match('#^/s/([a-zA-Z0-9_-]+)(?:/([^/]+))?$#', $path, $matches)) {
    route_share($matches[1], $matches[2] ?? null);
}

if ($path === '/captcha') {
    render_captcha_image();
}

if ($path === '/logout' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    check_csrf();
    session_destroy();
    redirect('/');
}

if ($path === '/email-code' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    check_csrf();
    if (!allow_registration()) {
        flash('error', '当前未开放注册');
        redirect('/register');
    }
    if (!email_verification_available()) {
        redirect('/register');
    }
    $email = trim((string)($_POST['email'] ?? ($_SESSION['register_email'] ?? '')));
    $_SESSION['register_email'] = $email;
    if (($_SESSION['register_step'] ?? '') !== 'verify') {
        flash('error', '请先完成注册信息');
        redirect('/register');
    }
    $captchaInput = (string)($_POST['captcha'] ?? '');
    if (captcha_enabled() && $captchaInput !== '' && !check_captcha($captchaInput)) {
        flash('error', '验证码错误');
        redirect('/register?step=verify');
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        flash('error', '邮箱格式不正确');
        redirect('/register?step=verify');
    }
    $lastSent = (int)($_SESSION['register_email_code_at'] ?? 0);
    if ($lastSent && (time() - $lastSent) < 60) {
        flash('error', '请稍后再发送验证码');
        redirect('/register?step=verify');
    }
    $code = create_email_code($email, $_SERVER['REMOTE_ADDR'] ?? '');
    if (!send_email_code($email, $code)) {
        flash('error', '验证码发送失败，请检查邮件配置');
        redirect('/register?step=verify');
    }
    $_SESSION['register_email_code_at'] = time();
    flash('info', '验证码已发送，请查收邮件');
    redirect('/register?step=verify');
}

if ($path === '/login/email/prepare' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!email_verification_available()) {
        redirect('/login');
    }
    check_csrf();
    $email = trim((string)($_POST['email'] ?? ''));
    $captchaInput = (string)($_POST['captcha'] ?? '');
    $_SESSION['login_email'] = $email;
    $_SESSION['login_tab'] = 'email';
    if (captcha_enabled() && !check_captcha($captchaInput)) {
        flash('error', '验证码错误');
        redirect('/login?tab=email');
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        flash('error', '邮箱格式不正确');
        redirect('/login?tab=email');
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT disabled FROM users WHERE email = :email LIMIT 1');
    $stmt->execute([':email' => $email]);
    $userRow = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$userRow) {
        flash('error', '该邮箱未注册');
        redirect('/login?tab=email');
    }
    if ((int)$userRow['disabled'] === 1) {
        flash('error', '账号已被停用');
        redirect('/login?tab=email');
    }
    $_SESSION['login_email_step'] = 'verify';
    redirect('/login?tab=email&step=verify');
}

if ($path === '/login/email-code' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!email_verification_available()) {
        redirect('/login');
    }
    check_csrf();
    if (($_SESSION['login_email_step'] ?? '') !== 'verify') {
        flash('error', '请先输入邮箱');
        redirect('/login?tab=email');
    }
    $email = trim((string)($_POST['email'] ?? ($_SESSION['login_email'] ?? '')));
    $_SESSION['login_email'] = $email;
    $_SESSION['login_tab'] = 'email';
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        flash('error', '邮箱格式不正确');
        redirect('/login?tab=email&step=verify');
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = :email LIMIT 1');
    $stmt->execute([':email' => $email]);
    if (!$stmt->fetchColumn()) {
        flash('error', '该邮箱未注册');
        redirect('/login?tab=email&step=verify');
    }
    $lastSent = (int)($_SESSION['login_email_code_at'] ?? 0);
    if ($lastSent && (time() - $lastSent) < 60) {
        flash('error', '请稍后再发送验证码');
        redirect('/login?tab=email&step=verify');
    }
    $code = create_email_code($email, $_SERVER['REMOTE_ADDR'] ?? '');
    if (!send_email_code($email, $code)) {
        flash('error', '验证码发送失败，请检查邮件配置');
        redirect('/login?tab=email&step=verify');
    }
    $_SESSION['login_email_code_at'] = time();
    flash('info', '验证码已发送，请查收邮件');
    redirect('/login?tab=email&step=verify');
}

if ($path === '/login/email' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!email_verification_available()) {
        redirect('/login');
    }
    check_csrf();
    if (($_SESSION['login_email_step'] ?? '') !== 'verify') {
        flash('error', '请先输入邮箱');
        redirect('/login?tab=email');
    }
    $email = trim((string)($_POST['email'] ?? ($_SESSION['login_email'] ?? '')));
    $code = trim((string)($_POST['email_code'] ?? ''));
    $_SESSION['login_email'] = $email;
    $_SESSION['login_tab'] = 'email';
    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        flash('error', '邮箱格式不正确');
        redirect('/login?tab=email&step=verify');
    }
    if ($code === '' || !verify_email_code($email, $code)) {
        flash('error', '邮箱验证码错误');
        redirect('/login?tab=email&step=verify');
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM users WHERE email = :email LIMIT 1');
    $stmt->execute([':email' => $email]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$user) {
        flash('error', '该邮箱未注册');
        redirect('/login?tab=email&step=verify');
    }
    if ((int)$user['disabled'] === 1) {
        flash('error', '账号已被停用');
        redirect('/login?tab=email&step=verify');
    }
    $_SESSION['user_id'] = $user['id'];
    $_SESSION['password_hash'] = $user['password_hash'];
    $_SESSION['login_email_step'] = 'start';
    unset($_SESSION['login_email']);
    if ((int)$user['email_verified'] !== 1) {
        $update = $pdo->prepare('UPDATE users SET email_verified = 1, updated_at = :updated_at WHERE id = :id');
        $update->execute([':updated_at' => now(), ':id' => $user['id']]);
    }
    if ((int)$user['must_change_password'] === 1) {
        flash('info', '检测到默认密码，请先修改密码');
        redirect('/account');
    }
    redirect('/dashboard');
}

if ($path === '/login') {
    global $config;
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        check_csrf();
        $username = trim((string)($_POST['username'] ?? ''));
        $password = (string)($_POST['password'] ?? '');
        $captchaInput = (string)($_POST['captcha'] ?? '');
        $_SESSION['login_username'] = $username;
        $_SESSION['login_tab'] = 'password';
        if (captcha_enabled() && !check_captcha($captchaInput)) {
            flash('error', '验证码错误');
            redirect('/login');
        }
        $pdo = db();
        $stmt = $pdo->prepare('SELECT * FROM users WHERE username = :username');
        $stmt->execute([':username' => $username]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user || !password_verify($password, $user['password_hash'])) {
            flash('error', '用户名或密码错误');
            redirect('/login');
        }
        if ((int)$user['disabled'] === 1) {
            flash('error', '账号已被停用');
            redirect('/login');
        }
        $_SESSION['user_id'] = $user['id'];
        $_SESSION['password_hash'] = $user['password_hash'];
        $_SESSION['login_email_step'] = 'start';
        unset($_SESSION['login_username']);
        if ((int)$user['must_change_password'] === 1) {
            flash('info', '检测到默认密码，请先修改密码');
            redirect('/account');
        }
        redirect('/dashboard');
    }
    $error = flash('error');
    $info = flash('info');
    $brand = htmlspecialchars($config['app_name']);
    $iconUser = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z"/></svg>';
    $iconMail = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5z"/></svg>';
    $iconLock = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-6 8v-2a1 1 0 0 1 2 0v2zm3-8H10V7a2 2 0 0 1 4 0z"/></svg>';
    $iconShield = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2 4 5v6c0 5 3.6 9.2 8 11 4.4-1.8 8-6 8-11V5z"/></svg>';
    $tabQuery = (string)($_GET['tab'] ?? '');
    if ($tabQuery !== '') {
        $_SESSION['login_tab'] = $tabQuery;
    }
    $stepQuery = (string)($_GET['step'] ?? '');
    if ($stepQuery === 'verify') {
        $_SESSION['login_email_step'] = 'verify';
    } elseif ($stepQuery === 'prepare') {
        $_SESSION['login_email_step'] = 'start';
    }
    $prefillLoginEmail = $_SESSION['login_email'] ?? '';
    $prefillLoginUser = $_SESSION['login_username'] ?? '';
    $loginEmailStep = $_SESSION['login_email_step'] ?? 'start';
    if (!email_verification_available()) {
        $loginEmailStep = 'start';
    }
    if ($loginEmailStep === 'verify' && $prefillLoginEmail === '') {
        $loginEmailStep = 'start';
    }
    $loginTab = email_verification_available()
        ? (($_SESSION['login_tab'] ?? '') ?: ($loginEmailStep === 'verify' ? 'email' : 'password'))
        : 'password';
    if (!in_array($loginTab, ['password', 'email'], true)) {
        $loginTab = 'password';
    }
    $lastLoginSent = (int)($_SESSION['login_email_code_at'] ?? 0);
    $nextLoginCodeAt = ($lastLoginSent && (time() - $lastLoginSent) < 60) ? ($lastLoginSent + 60) : 0;
    $nextLoginAttr = $nextLoginCodeAt ? ' data-countdown-until="' . ($nextLoginCodeAt * 1000) . '"' : '';

    $content = '<div class="auth-card">';
    $content .= '<div class="auth-logo">' . $brand . '</div>';
    $content .= '<div class="auth-title">账号登录</div>';
    $content .= '<div class="auth-subtitle">欢迎回来，请登录继续</div>';
    if ($error) {
        $content .= '<div class="alert error">' . htmlspecialchars($error) . '</div>';
    }
    if ($info) {
        $content .= '<div class="alert info">' . htmlspecialchars($info) . '</div>';
    }
    if (email_verification_available()) {
        $content .= '<div class="auth-tabs" data-login-tabs data-login-default="' . $loginTab . '">';
        $content .= '<button class="auth-tab" type="button" data-login-tab="password">密码登录</button>';
        $content .= '<button class="auth-tab" type="button" data-login-tab="email">邮箱验证码</button>';
        $content .= '</div>';
    }
    $content .= '<form method="post" class="auth-form" data-login-panel="password"' . ($loginTab === 'password' ? '' : ' hidden') . '>';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<div class="auth-field"><span class="auth-icon">' . $iconUser . '</span><input class="auth-input" name="username" placeholder="用户名" value="' . htmlspecialchars((string)$prefillLoginUser) . '" required></div>';
    $content .= '<div class="auth-field"><span class="auth-icon">' . $iconLock . '</span><input class="auth-input" type="password" name="password" placeholder="密码" required></div>';
    if (captcha_enabled()) {
        $content .= '<div class="auth-field auth-field-captcha"><span class="auth-icon">' . $iconShield . '</span><input class="auth-input" name="captcha" placeholder="验证码" required>';
        $content .= '<img class="captcha-img" src="' . htmlspecialchars(captcha_url()) . '" alt="验证码" data-captcha></div>';
    }
    $content .= '<div class="auth-actions"><a class="link" href="' . base_path() . '/forgot">找回密码</a></div>';
    $content .= '<button class="button primary w-full" type="submit">登录</button>';
    $content .= '</form>';
    if (email_verification_available()) {
        if ($loginEmailStep === 'verify') {
            $content .= '<form method="post" class="auth-form" action="' . base_path() . '/login/email" data-login-panel="email"' . ($loginTab === 'email' ? '' : ' hidden') . '>';
            $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
            $content .= '<div class="auth-field"><span class="auth-icon">' . $iconMail . '</span><input class="auth-input" name="email" placeholder="邮箱" value="' . htmlspecialchars((string)$prefillLoginEmail) . '" readonly></div>';
            $content .= '<div class="auth-field"><span class="auth-icon">' . $iconMail . '</span><input class="auth-input" name="email_code" placeholder="邮箱验证码" required></div>';
            $content .= '<div class="auth-actions">';
            $content .= '<button class="button ghost" type="submit" formaction="' . base_path() . '/login/email-code" formnovalidate' . $nextLoginAttr . '>发送邮箱验证码</button>';
            $content .= '<a class="link" href="' . base_path() . '/login?tab=email&step=prepare">修改邮箱</a>';
            $content .= '</div>';
            $content .= '<button class="button primary w-full" type="submit">登录</button>';
            $content .= '</form>';
        } else {
            $content .= '<form method="post" class="auth-form" action="' . base_path() . '/login/email/prepare" data-login-panel="email"' . ($loginTab === 'email' ? '' : ' hidden') . '>';
            $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
            $content .= '<div class="auth-field"><span class="auth-icon">' . $iconMail . '</span><input class="auth-input" name="email" placeholder="邮箱" value="' . htmlspecialchars((string)$prefillLoginEmail) . '" required></div>';
            if (captcha_enabled()) {
                $content .= '<div class="auth-field auth-field-captcha"><span class="auth-icon">' . $iconShield . '</span><input class="auth-input" name="captcha" placeholder="验证码" required>';
                $content .= '<img class="captcha-img" src="' . htmlspecialchars(captcha_url()) . '" alt="验证码" data-captcha></div>';
            }
            $content .= '<button class="button primary w-full" type="submit">下一步</button>';
            $content .= '</form>';
        }
    }
    $content .= '<div class="auth-footer">没有账号？ <a class="link" href="' . base_path() . '/register">立即注册</a></div>';
    $content .= '</div>';
    render_page('登录', $content, null, '', ['layout' => 'auth']);
}

if ($path === '/register') {
    global $config;
    if (!allow_registration()) {
        render_page('注册', '<div class="auth-card"><div class="auth-title">暂未开放注册</div></div>', null, '', ['layout' => 'auth']);
    }
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        check_csrf();
        $step = trim((string)($_POST['step'] ?? 'info'));
        $username = trim((string)($_POST['username'] ?? ($_SESSION['register_username'] ?? '')));
        $email = trim((string)($_POST['email'] ?? ($_SESSION['register_email'] ?? '')));
        $password = (string)($_POST['password'] ?? '');
        $captchaInput = (string)($_POST['captcha'] ?? '');
        $_SESSION['register_username'] = $username;
        $_SESSION['register_email'] = $email;
        if ($step === 'info' && captcha_enabled() && !check_captcha($captchaInput)) {
            flash('error', '验证码错误');
            redirect('/register');
        }
        if ($step === 'info') {
            if ($username === '' || $password === '') {
                flash('error', '用户名和密码不能为空');
                redirect('/register');
            }
            if (strlen($password) < 6) {
                flash('error', '密码至少 6 位');
                redirect('/register');
            }
            if (email_verification_available()) {
                if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
                    flash('error', '邮箱格式不正确');
                    redirect('/register');
                }
                $_SESSION['register_password_hash'] = password_hash($password, PASSWORD_DEFAULT);
                $_SESSION['register_step'] = 'verify';
                redirect('/register?step=verify');
            }

            if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
                flash('error', '邮箱格式不正确');
                redirect('/register');
            }
            $emailVerified = $email !== '' ? 1 : 0;
            $pdo = db();
            if ($email !== '') {
                $checkEmail = $pdo->prepare('SELECT id FROM users WHERE email = :email LIMIT 1');
                $checkEmail->execute([':email' => $email]);
                if ($checkEmail->fetch()) {
                    flash('error', '该邮箱已注册');
                    redirect('/register');
                }
            }
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
            $stmt = $pdo->prepare('INSERT INTO users (username, email, password_hash, role, api_key_hash, api_key_prefix, api_key_last4, disabled, storage_limit_bytes, storage_used_bytes, must_change_password, email_verified, created_at, updated_at)
                VALUES (:username, :email, :password_hash, :role, :api_key_hash, :api_key_prefix, :api_key_last4, :disabled, :storage_limit_bytes, :storage_used_bytes, :must_change_password, :email_verified, :created_at, :updated_at)');
            try {
                $stmt->execute([
                    ':username' => $username,
                    ':email' => $email,
                    ':password_hash' => $passwordHash,
                    ':role' => 'user',
                    ':api_key_hash' => null,
                    ':api_key_prefix' => null,
                    ':api_key_last4' => null,
                    ':disabled' => 0,
                    ':storage_limit_bytes' => 0,
                    ':storage_used_bytes' => 0,
                    ':must_change_password' => 0,
                    ':email_verified' => $emailVerified,
                    ':created_at' => now(),
                    ':updated_at' => now(),
                ]);
            } catch (PDOException $e) {
                flash('error', '用户名已存在');
                redirect('/register');
            }
            unset($_SESSION['register_step'], $_SESSION['register_password_hash'], $_SESSION['register_email_code_at'], $_SESSION['register_username'], $_SESSION['register_email']);
            $_SESSION['user_id'] = (int)$pdo->lastInsertId();
            $_SESSION['password_hash'] = $passwordHash;
            redirect('/dashboard');
        }

        if (!email_verification_available()) {
            redirect('/register');
        }
        $passwordHash = (string)($_SESSION['register_password_hash'] ?? '');
        if ($passwordHash === '') {
            $_SESSION['register_step'] = 'info';
            flash('error', '请先填写注册信息');
            redirect('/register');
        }
        $emailCode = trim((string)($_POST['email_code'] ?? ''));
        if ($username === '') {
            flash('error', '用户名不能为空');
            redirect('/register?step=verify');
        }
        if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            flash('error', '邮箱格式不正确');
            redirect('/register?step=verify');
        }
        if ($emailCode === '' || !verify_email_code($email, $emailCode)) {
            flash('error', '邮箱验证码错误');
            redirect('/register?step=verify');
        }
        $pdo = db();
        $checkEmail = $pdo->prepare('SELECT id FROM users WHERE email = :email LIMIT 1');
        $checkEmail->execute([':email' => $email]);
        if ($checkEmail->fetch()) {
            flash('error', '该邮箱已注册');
            redirect('/register?step=verify');
        }
        $stmt = $pdo->prepare('INSERT INTO users (username, email, password_hash, role, api_key_hash, api_key_prefix, api_key_last4, disabled, storage_limit_bytes, storage_used_bytes, must_change_password, email_verified, created_at, updated_at)
            VALUES (:username, :email, :password_hash, :role, :api_key_hash, :api_key_prefix, :api_key_last4, :disabled, :storage_limit_bytes, :storage_used_bytes, :must_change_password, :email_verified, :created_at, :updated_at)');
        try {
            $stmt->execute([
                ':username' => $username,
                ':email' => $email,
                ':password_hash' => $passwordHash,
                ':role' => 'user',
                ':api_key_hash' => null,
                ':api_key_prefix' => null,
                ':api_key_last4' => null,
                ':disabled' => 0,
                ':storage_limit_bytes' => 0,
                ':storage_used_bytes' => 0,
                ':must_change_password' => 0,
                ':email_verified' => 1,
                ':created_at' => now(),
                ':updated_at' => now(),
            ]);
        } catch (PDOException $e) {
            flash('error', '用户名已存在');
            redirect('/register?step=verify');
        }
        unset(
            $_SESSION['register_step'],
            $_SESSION['register_password_hash'],
            $_SESSION['register_email_code_at'],
            $_SESSION['register_username'],
            $_SESSION['register_email']
        );
        $_SESSION['user_id'] = (int)$pdo->lastInsertId();
        $_SESSION['password_hash'] = $passwordHash;
        redirect('/dashboard');
    }
    $error = flash('error');
    $info = flash('info');
    $stepQuery = (string)($_GET['step'] ?? '');
    if ($stepQuery === 'verify') {
        $_SESSION['register_step'] = 'verify';
    } elseif ($stepQuery === 'info') {
        $_SESSION['register_step'] = 'info';
    }
    $registerStep = $_SESSION['register_step'] ?? 'info';
    if (!email_verification_available()) {
        $registerStep = 'info';
    }
    if ($registerStep === 'verify' && empty($_SESSION['register_password_hash'])) {
        $registerStep = 'info';
    }
    $_SESSION['register_step'] = $registerStep;
    $prefillName = $_SESSION['register_username'] ?? '';
    $prefillEmail = $_SESSION['register_email'] ?? '';
    $brand = htmlspecialchars($config['app_name']);
    $iconUser = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z"/></svg>';
    $iconMail = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5z"/></svg>';
    $iconLock = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-6 8v-2a1 1 0 0 1 2 0v2zm3-8H10V7a2 2 0 0 1 4 0z"/></svg>';
    $iconShield = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2 4 5v6c0 5 3.6 9.2 8 11 4.4-1.8 8-6 8-11V5z"/></svg>';
    $lastSent = (int)($_SESSION['register_email_code_at'] ?? 0);
    $nextCodeAt = ($lastSent && (time() - $lastSent) < 60) ? ($lastSent + 60) : 0;
    $nextCodeAttr = $nextCodeAt ? ' data-countdown-until="' . ($nextCodeAt * 1000) . '"' : '';
    $content = '<div class="auth-card">';
    $content .= '<div class="auth-logo">' . $brand . '</div>';
    $content .= '<div class="auth-title">注册账号</div>';
    $content .= '<div class="auth-subtitle">填写信息创建账号</div>';
    if ($error) {
        $content .= '<div class="alert error">' . htmlspecialchars($error) . '</div>';
    }
    if ($info) {
        $content .= '<div class="alert info">' . htmlspecialchars($info) . '</div>';
    }
    if (email_verification_available()) {
        $content .= '<div class="auth-steps">';
        $content .= '<div class="auth-step' . ($registerStep === 'info' ? ' is-active' : '') . '"><span>1</span>填写信息</div>';
        $content .= '<div class="auth-step' . ($registerStep === 'verify' ? ' is-active' : '') . '"><span>2</span>邮箱验证</div>';
        $content .= '</div>';
    }
    if ($registerStep === 'verify' && email_verification_available()) {
        $content .= '<form method="post" class="auth-form">';
        $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
        $content .= '<input type="hidden" name="step" value="verify">';
        $content .= '<div class="auth-field"><span class="auth-icon">' . $iconUser . '</span><input class="auth-input" name="username" placeholder="用户名" value="' . htmlspecialchars((string)$prefillName) . '" readonly></div>';
        $content .= '<div class="auth-field"><span class="auth-icon">' . $iconMail . '</span><input class="auth-input" name="email" placeholder="邮箱" value="' . htmlspecialchars((string)$prefillEmail) . '" readonly></div>';
        $content .= '<div class="auth-field"><span class="auth-icon">' . $iconMail . '</span><input class="auth-input" name="email_code" placeholder="邮箱验证码" required></div>';
        $content .= '<div class="auth-actions">';
        $content .= '<button class="button ghost" type="submit" formaction="' . base_path() . '/email-code" formnovalidate' . $nextCodeAttr . '>发送邮箱验证码</button>';
        $content .= '<a class="link" href="' . base_path() . '/register?step=info">修改信息</a>';
        $content .= '</div>';
        $content .= '<button class="button primary w-full" type="submit">注册</button>';
        $content .= '<div class="auth-footer">已有账号？ <a class="link" href="' . base_path() . '/login">立即登录</a></div>';
        $content .= '</form>';
    } else {
        $content .= '<form method="post" class="auth-form">';
        $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
        $content .= '<input type="hidden" name="step" value="info">';
        $content .= '<div class="auth-field"><span class="auth-icon">' . $iconUser . '</span><input class="auth-input" name="username" placeholder="用户名" value="' . htmlspecialchars((string)$prefillName) . '" required></div>';
        $content .= '<div class="auth-field"><span class="auth-icon">' . $iconMail . '</span><input class="auth-input" name="email" placeholder="邮箱" value="' . htmlspecialchars((string)$prefillEmail) . '"' . (email_verification_available() ? ' required' : '') . '></div>';
        $content .= '<div class="auth-field"><span class="auth-icon">' . $iconLock . '</span><input class="auth-input" type="password" name="password" placeholder="密码" required></div>';
        if (captcha_enabled()) {
            $content .= '<div class="auth-field auth-field-captcha"><span class="auth-icon">' . $iconShield . '</span><input class="auth-input" name="captcha" placeholder="验证码" required>';
            $content .= '<img class="captcha-img" src="' . htmlspecialchars(captcha_url()) . '" alt="验证码" data-captcha></div>';
        }
        $content .= '<button class="button primary w-full" type="submit">' . (email_verification_available() ? '下一步' : '注册') . '</button>';
        $content .= '<div class="auth-footer">已有账号？ <a class="link" href="' . base_path() . '/login">立即登录</a></div>';
        $content .= '</form>';
    }
    $content .= '</div>';
    render_page('注册', $content, null, '', ['layout' => 'auth']);
}

if ($path === '/forgot') {
    global $config;
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        check_csrf();
        $email = trim((string)($_POST['email'] ?? ''));
        $captchaInput = (string)($_POST['captcha'] ?? '');
        if (captcha_enabled() && !check_captcha($captchaInput)) {
            flash('error', '验证码错误');
            redirect('/forgot');
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            flash('error', '邮箱格式不正确');
            redirect('/forgot');
        }
        $lastSent = (int)($_SESSION['reset_code_at'] ?? 0);
        if ($lastSent && (time() - $lastSent) < 60) {
            flash('error', '发送过于频繁，请稍后再试');
            redirect('/forgot');
        }
        $pdo = db();
        $stmt = $pdo->prepare('SELECT * FROM users WHERE email = :email LIMIT 1');
        $stmt->execute([':email' => $email]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($user && (int)$user['disabled'] !== 1) {
            $code = create_reset_code((int)$user['id'], $email, $_SERVER['REMOTE_ADDR'] ?? '');
            $sent = send_reset_code($email, $code);
            if (!$sent) {
                flash('error', '验证码发送失败，请检查邮件配置');
                redirect('/forgot');
            }
            $_SESSION['reset_code_at'] = time();
        }
        flash('info', '如果邮箱存在，重置码已发送');
        redirect('/reset');
    }

    $error = flash('error');
    $info = flash('info');
    $brand = htmlspecialchars($config['app_name']);
    $iconMail = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5z"/></svg>';
    $iconShield = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2 4 5v6c0 5 3.6 9.2 8 11 4.4-1.8 8-6 8-11V5z"/></svg>';
    $content = '<div class="auth-card">';
    $content .= '<div class="auth-logo">' . $brand . '</div>';
    $content .= '<div class="auth-title">找回密码</div>';
    $content .= '<div class="auth-subtitle">输入邮箱获取重置码</div>';
    if ($error) {
        $content .= '<div class="alert error">' . htmlspecialchars($error) . '</div>';
    }
    if ($info) {
        $content .= '<div class="alert info">' . htmlspecialchars($info) . '</div>';
    }
    $content .= '<form method="post" class="auth-form">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<div class="auth-field"><span class="auth-icon">' . $iconMail . '</span><input class="auth-input" name="email" placeholder="邮箱" required></div>';
    if (captcha_enabled()) {
        $content .= '<div class="auth-field auth-field-captcha"><span class="auth-icon">' . $iconShield . '</span><input class="auth-input" name="captcha" placeholder="验证码" required>';
        $content .= '<img class="captcha-img" src="' . htmlspecialchars(captcha_url()) . '" alt="验证码" data-captcha></div>';
    }
    $content .= '<button class="button primary w-full" type="submit">发送重置码</button>';
    $content .= '<div class="auth-footer"><a class="link" href="' . base_path() . '/login">返回登录</a></div>';
    $content .= '</form></div>';
    render_page('找回密码', $content, null, '', ['layout' => 'auth']);
}

if ($path === '/reset') {
    global $config;
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        check_csrf();
        $email = trim((string)($_POST['email'] ?? ''));
        $code = trim((string)($_POST['code'] ?? ''));
        $password = (string)($_POST['password'] ?? '');
        $confirm = (string)($_POST['confirm_password'] ?? '');
        if ($email === '' || $code === '' || $password === '' || $confirm === '') {
            flash('error', '请填写完整信息');
            redirect('/reset');
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            flash('error', '邮箱格式不正确');
            redirect('/reset');
        }
        if (strlen($password) < 6) {
            flash('error', '密码至少 6 位');
            redirect('/reset');
        }
        if ($password !== $confirm) {
            flash('error', '两次密码不一致');
            redirect('/reset');
        }
        $pdo = db();
        $stmt = $pdo->prepare('SELECT * FROM users WHERE email = :email LIMIT 1');
        $stmt->execute([':email' => $email]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user) {
            flash('error', '账号不存在');
            redirect('/reset');
        }
        if (!verify_reset_code((int)$user['id'], $email, $code)) {
            flash('error', '验证码无效或已过期');
            redirect('/reset');
        }
        $update = $pdo->prepare('UPDATE users SET password_hash = :hash, must_change_password = 0, updated_at = :updated_at WHERE id = :id');
        $update->execute([
            ':hash' => password_hash($password, PASSWORD_DEFAULT),
            ':updated_at' => now(),
            ':id' => $user['id'],
        ]);
        flash('info', '密码已重置，请登录');
        redirect('/login');
    }
    $error = flash('error');
    $info = flash('info');
    $brand = htmlspecialchars($config['app_name']);
    $iconMail = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5z"/></svg>';
    $iconLock = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-6 8v-2a1 1 0 0 1 2 0v2zm3-8H10V7a2 2 0 0 1 4 0z"/></svg>';
    $content = '<div class="auth-card">';
    $content .= '<div class="auth-logo">' . $brand . '</div>';
    $content .= '<div class="auth-title">重置密码</div>';
    $content .= '<div class="auth-subtitle">输入邮箱与验证码设置新密码</div>';
    if ($error) {
        $content .= '<div class="alert error">' . htmlspecialchars($error) . '</div>';
    }
    if ($info) {
        $content .= '<div class="alert info">' . htmlspecialchars($info) . '</div>';
    }
    $content .= '<form method="post" class="auth-form">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<div class="auth-field"><span class="auth-icon">' . $iconMail . '</span><input class="auth-input" name="email" placeholder="邮箱" required></div>';
    $content .= '<div class="auth-field"><span class="auth-icon">' . $iconMail . '</span><input class="auth-input" name="code" placeholder="邮箱验证码" required></div>';
    $content .= '<div class="auth-field"><span class="auth-icon">' . $iconLock . '</span><input class="auth-input" type="password" name="password" placeholder="新密码" required></div>';
    $content .= '<div class="auth-field"><span class="auth-icon">' . $iconLock . '</span><input class="auth-input" type="password" name="confirm_password" placeholder="确认密码" required></div>';
    $content .= '<button class="button primary w-full" type="submit">重置密码</button>';
    $content .= '<div class="auth-footer"><a class="link" href="' . base_path() . '/login">返回登录</a></div>';
    $content .= '</form></div>';
    render_page('重置密码', $content, null, '', ['layout' => 'auth']);
}

if ($path === '/account/email-code' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $user = require_login();
    check_csrf();
    $email = trim((string)($_POST['new_email'] ?? ''));
    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        flash('error', '请输入有效的新邮箱');
        redirect('/account');
    }
    if (strcasecmp($email, (string)($user['email'] ?? '')) === 0) {
        flash('error', '新邮箱不能与当前邮箱相同');
        redirect('/account');
    }
    $lastSent = (int)($_SESSION['account_email_code_at'] ?? 0);
    if ($lastSent && (time() - $lastSent) < 60) {
        flash('error', '请稍后再发送验证码');
        redirect('/account');
    }
    $code = create_email_code($email, $_SERVER['REMOTE_ADDR'] ?? '');
    if (!send_email_code($email, $code)) {
        flash('error', '验证码发送失败，请检查邮件配置');
        redirect('/account');
    }
    $_SESSION['account_email_code_at'] = time();
    $_SESSION['account_email_target'] = $email;
    flash('info', '验证码已发送，请查收邮件');
    redirect('/account');
}

if ($path === '/account/email-change' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $user = require_login();
    check_csrf();
    $email = trim((string)($_POST['new_email'] ?? ''));
    $code = trim((string)($_POST['email_code'] ?? ''));
    if ($email === '' || $code === '') {
        flash('error', '请填写完整信息');
        redirect('/account');
    }
    $target = (string)($_SESSION['account_email_target'] ?? '');
    if ($target === '' || strcasecmp($target, $email) !== 0) {
        flash('error', '请先获取该邮箱验证码');
        redirect('/account');
    }
    if (!verify_email_code($email, $code)) {
        flash('error', '邮箱验证码错误');
        redirect('/account');
    }
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE users SET email = :email, email_verified = 1, updated_at = :updated_at WHERE id = :id');
    $stmt->execute([
        ':email' => $email,
        ':updated_at' => now(),
        ':id' => $user['id'],
    ]);
    unset($_SESSION['account_email_target'], $_SESSION['account_email_code_at']);
    flash('info', '邮箱已更新');
    redirect('/account');
}

if ($path === '/account') {
    $user = require_login();
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        check_csrf();
        $current = (string)($_POST['current_password'] ?? '');
        $new = (string)($_POST['new_password'] ?? '');
        $confirm = (string)($_POST['confirm_password'] ?? '');
        if ($new === '' || $confirm === '') {
            flash('error', '请填写完整信息');
            redirect('/account');
        }
        if (strlen($new) < 6) {
            flash('error', '新密码至少 6 位');
            redirect('/account');
        }
        if ($new !== $confirm) {
            flash('error', '两次输入的新密码不一致');
            redirect('/account');
        }
        if (!password_verify($current, $user['password_hash'])) {
            flash('error', '当前密码错误');
            redirect('/account');
        }
        $pdo = db();
        $stmt = $pdo->prepare('UPDATE users SET password_hash = :hash, must_change_password = 0, updated_at = :updated_at WHERE id = :id');
        $stmt->execute([
            ':hash' => password_hash($new, PASSWORD_DEFAULT),
            ':updated_at' => now(),
            ':id' => $user['id'],
        ]);
        unset($_SESSION['user_id'], $_SESSION['password_hash']);
        session_regenerate_id(true);
        flash('info', '???????????');
        redirect('/login');
    }

    $error = flash('error');
    $info = flash('info');
    $content = '<div class="card"><h2>账号设置</h2>';
    if ($error) {
        $content .= '<div class="flash">' . htmlspecialchars($error) . '</div>';
    }
    if ($info) {
        $content .= '<div class="flash">' . htmlspecialchars($info) . '</div>';
    }
    if ((int)$user['must_change_password'] === 1) {
        $content .= '<div class="notice">当前为默认密码，请尽快修改。</div>';
    }
    $content .= '<form method="post" style="margin-top:12px">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<div class="grid">';
    $content .= '<div><label>当前密码</label><input class="input" type="password" name="current_password" required></div>';
    $content .= '<div><label>新密码</label><input class="input" type="password" name="new_password" required></div>';
    $content .= '<div><label>确认新密码</label><input class="input" type="password" name="confirm_password" required></div>';
    $content .= '</div>';
    $content .= '<div style="margin-top:12px"><button class="button primary" type="submit">更新密码</button></div>';
    $content .= '</form></div>';

    $currentEmail = trim((string)($user['email'] ?? ''));
    $currentEmailLabel = $currentEmail !== '' ? htmlspecialchars($currentEmail) : '未绑定';
    $pendingEmail = (string)($_SESSION['account_email_target'] ?? '');
    $content .= '<div class="card"><h2>换绑邮箱</h2>';
    $content .= '<p class="muted">当前邮箱：' . $currentEmailLabel . '</p>';
    $content .= '<form method="post" action="' . base_path() . '/account/email-change" style="margin-top:12px">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<div class="grid">';
    $content .= '<div><label>新邮箱</label><input class="input" type="email" name="new_email" value="' . htmlspecialchars($pendingEmail) . '" required></div>';
    $content .= '<div><label>邮箱验证码</label><input class="input" name="email_code" placeholder="请输入验证码" required></div>';
    $content .= '</div>';
    $content .= '<div class="form-actions" style="margin-top:12px">';
    $content .= '<button class="button ghost" type="submit" formaction="' . base_path() . '/account/email-code" formnovalidate>发送邮箱验证码</button>';
    $content .= '<button class="button primary" type="submit">更换邮箱</button>';
    $content .= '</div>';
    $content .= '</form></div>';
    $titleHtml = build_topbar_title('账号设置', $user);
    render_page('账号设置', $content, $user, '', ['title_html' => $titleHtml]);
}

if ($path === '/dashboard') {
    $user = require_login();
    $pdo = db();
    $usedBytes = recalculate_user_storage((int)$user['id']);
    $user['storage_used_bytes'] = $usedBytes;
    $limitBytes = get_user_limit_bytes($user);
    $limitLabel = $limitBytes > 0 ? format_bytes($limitBytes) : '不限';
    $limitSource = ((int)$user['storage_limit_bytes'] > 0) ? '自定义' : '默认';
    $storageFull = $limitBytes > 0 && $usedBytes >= $limitBytes;
    $shareSearch = trim((string)($_GET['share_search'] ?? ''));
    $sharePage = max(1, (int)($_GET['share_page'] ?? 1));
    $shareSize = normalize_page_size($_GET['share_size'] ?? 10);
    $filterStatus = (string)($_GET['status'] ?? 'active');
    if (!in_array($filterStatus, ['active', 'deleted', 'all'], true)) {
        $filterStatus = 'active';
    }
    $where = ['user_id = :uid'];
    $params = [':uid' => $user['id']];
    if ($shareSearch !== '') {
        $where[] = '(title LIKE :share_search OR slug LIKE :share_search)';
        $params[':share_search'] = '%' . $shareSearch . '%';
    }
    if ($filterStatus === 'active') {
        $where[] = 'deleted_at IS NULL';
    } elseif ($filterStatus === 'deleted') {
        $where[] = 'deleted_at IS NOT NULL';
    }
    $shareSql = 'SELECT * FROM shares';
    $shareCountSql = 'SELECT COUNT(*) FROM shares';
    if (!empty($where)) {
        $shareSql .= ' WHERE ' . implode(' AND ', $where);
        $shareCountSql .= ' WHERE ' . implode(' AND ', $where);
    }
    $shareCountStmt = $pdo->prepare($shareCountSql);
    $shareCountStmt->execute($params);
    $totalShares = (int)$shareCountStmt->fetchColumn();
    [$sharePage, $shareSize, $sharePages, $shareOffset] = paginate($totalShares, $sharePage, $shareSize);
    $shareSql .= ' ORDER BY updated_at DESC LIMIT :limit OFFSET :offset';
    $stmt = $pdo->prepare($shareSql);
    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value);
    }
    $stmt->bindValue(':limit', $shareSize, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $shareOffset, PDO::PARAM_INT);
    $stmt->execute();
    $shares = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $shareQuery = $_GET;
    unset($shareQuery['share_page'], $shareQuery['share_size'], $shareQuery['share_search'], $shareQuery['status']);
    $accessShare = trim((string)($_GET['access_share'] ?? 'all'));
    $accessPage = max(1, (int)($_GET['access_page'] ?? 1));
    $accessSize = normalize_page_size($_GET['access_size'] ?? 10);
    $accessSourcePage = max(1, (int)($_GET['access_source_page'] ?? 1));
    $accessSourceSize = normalize_page_size($_GET['access_source_size'] ?? 10);
    $accessShareId = 0;
    if ($accessShare !== '' && $accessShare !== 'all') {
        $accessShareId = (int)$accessShare;
    }
    if ($accessShareId > 0) {
        $checkShare = $pdo->prepare('SELECT id FROM shares WHERE id = :id AND user_id = :uid LIMIT 1');
        $checkShare->execute([':id' => $accessShareId, ':uid' => $user['id']]);
        if (!$checkShare->fetchColumn()) {
            $accessShareId = 0;
        }
    }
    $accessEnabled = access_stats_enabled((int)$user['id']);
    $accessRetention = access_stats_retention_days((int)$user['id']);
    $accessShareOptionsStmt = $pdo->prepare('SELECT id, title, slug FROM shares WHERE user_id = :uid AND deleted_at IS NULL ORDER BY updated_at DESC');
    $accessShareOptionsStmt->execute([':uid' => $user['id']]);
    $accessShareOptions = $accessShareOptionsStmt->fetchAll(PDO::FETCH_ASSOC);
    $accessWhere = ['share_access_logs.user_id = :uid'];
    $accessParams = [':uid' => $user['id']];
    if ($accessShareId > 0) {
        $accessWhere[] = 'share_access_logs.share_id = :sid';
        $accessParams[':sid'] = $accessShareId;
    }
    $accessWhereSql = implode(' AND ', $accessWhere);
    $todayStart = date('Y-m-d H:i:s', strtotime('today'));
    $tomorrowStart = date('Y-m-d H:i:s', strtotime('tomorrow'));
    $yesterdayStart = date('Y-m-d H:i:s', strtotime('yesterday'));
    $summarySql = 'SELECT
        SUM(CASE WHEN created_at >= :today_start AND created_at < :tomorrow_start THEN 1 ELSE 0 END) AS pv_today,
        SUM(CASE WHEN created_at >= :yesterday_start AND created_at < :today_start THEN 1 ELSE 0 END) AS pv_yesterday,
        COUNT(*) AS pv_total,
        COUNT(DISTINCT CASE WHEN created_at >= :today_start AND created_at < :tomorrow_start THEN visitor_id END) AS uv_today,
        COUNT(DISTINCT CASE WHEN created_at >= :yesterday_start AND created_at < :today_start THEN visitor_id END) AS uv_yesterday,
        COUNT(DISTINCT visitor_id || ":" || substr(created_at, 1, 10)) AS uv_total,
        COUNT(DISTINCT CASE WHEN created_at >= :today_start AND created_at < :tomorrow_start THEN ip END) AS ip_today,
        COUNT(DISTINCT CASE WHEN created_at >= :yesterday_start AND created_at < :today_start THEN ip END) AS ip_yesterday,
        COUNT(DISTINCT ip) AS ip_total
        FROM share_access_logs WHERE ' . $accessWhereSql;
    $summaryStmt = $pdo->prepare($summarySql);
    $summaryParams = array_merge($accessParams, [
        ':today_start' => $todayStart,
        ':tomorrow_start' => $tomorrowStart,
        ':yesterday_start' => $yesterdayStart,
    ]);
    $summaryStmt->execute($summaryParams);
    $summaryRow = $summaryStmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $accessSummary = [
        'pv_today' => (int)($summaryRow['pv_today'] ?? 0),
        'pv_yesterday' => (int)($summaryRow['pv_yesterday'] ?? 0),
        'pv_total' => (int)($summaryRow['pv_total'] ?? 0),
        'uv_today' => (int)($summaryRow['uv_today'] ?? 0),
        'uv_yesterday' => (int)($summaryRow['uv_yesterday'] ?? 0),
        'uv_total' => (int)($summaryRow['uv_total'] ?? 0),
        'ip_today' => (int)($summaryRow['ip_today'] ?? 0),
        'ip_yesterday' => (int)($summaryRow['ip_yesterday'] ?? 0),
        'ip_total' => (int)($summaryRow['ip_total'] ?? 0),
    ];
    $sourceCountStmt = $pdo->prepare('SELECT COUNT(*) FROM (SELECT referer FROM share_access_logs WHERE ' . $accessWhereSql . ' AND referer != "" GROUP BY referer) AS t');
    $sourceCountStmt->execute($accessParams);
    $accessSourceTotal = (int)$sourceCountStmt->fetchColumn();
    [$accessSourcePage, $accessSourceSize, $accessSourcePages, $accessSourceOffset] = paginate(
        $accessSourceTotal,
        $accessSourcePage,
        $accessSourceSize
    );
    $sourceSql = 'SELECT referer, COUNT(*) AS total FROM share_access_logs WHERE ' . $accessWhereSql . ' AND referer != "" GROUP BY referer ORDER BY total DESC LIMIT :limit OFFSET :offset';
    $sourceStmt = $pdo->prepare($sourceSql);
    foreach ($accessParams as $key => $value) {
        $sourceStmt->bindValue($key, $value);
    }
    $sourceStmt->bindValue(':limit', $accessSourceSize, PDO::PARAM_INT);
    $sourceStmt->bindValue(':offset', $accessSourceOffset, PDO::PARAM_INT);
    $sourceStmt->execute();
    $accessSources = $sourceStmt->fetchAll(PDO::FETCH_ASSOC);
    $regionCnStmt = $pdo->prepare('SELECT ip_region AS label, COUNT(*) AS total FROM share_access_logs WHERE ' . $accessWhereSql . ' AND ip_country_code = "CN" AND ip_region != "" GROUP BY ip_region ORDER BY total DESC LIMIT 12');
    $regionCnStmt->execute($accessParams);
    $accessRegionsCn = $regionCnStmt->fetchAll(PDO::FETCH_ASSOC);
    $regionIntlStmt = $pdo->prepare('SELECT ip_country AS label, COUNT(*) AS total FROM share_access_logs WHERE ' . $accessWhereSql . ' AND (ip_country_code IS NULL OR ip_country_code != "CN") AND ip_country != "" GROUP BY ip_country ORDER BY total DESC LIMIT 12');
    $regionIntlStmt->execute($accessParams);
    $accessRegionsIntl = $regionIntlStmt->fetchAll(PDO::FETCH_ASSOC);
    $accessCnMax = 0;
    foreach ($accessRegionsCn as $row) {
        $accessCnMax = max($accessCnMax, (int)($row['total'] ?? 0));
    }
    $accessIntlMax = 0;
    foreach ($accessRegionsIntl as $row) {
        $accessIntlMax = max($accessIntlMax, (int)($row['total'] ?? 0));
    }
    $accessCountStmt = $pdo->prepare('SELECT COUNT(*) FROM share_access_logs WHERE ' . $accessWhereSql);
    $accessCountStmt->execute($accessParams);
    $accessTotal = (int)$accessCountStmt->fetchColumn();
    $accessSizeStmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM share_access_logs WHERE user_id = :uid');
    $accessSizeStmt->execute([':uid' => $user['id']]);
    $accessLogTotalBytes = (int)$accessSizeStmt->fetchColumn();
    $accessLogTotalLabel = format_bytes($accessLogTotalBytes);
    [$accessPage, $accessSize, $accessPages, $accessOffset] = paginate($accessTotal, $accessPage, $accessSize);
    $accessSql = 'SELECT share_access_logs.*, shares.slug, shares.title AS share_title
        FROM share_access_logs
        JOIN shares ON share_access_logs.share_id = shares.id
        WHERE ' . $accessWhereSql . '
        ORDER BY share_access_logs.created_at DESC
        LIMIT :limit OFFSET :offset';
    $accessStmt = $pdo->prepare($accessSql);
    foreach ($accessParams as $key => $value) {
        $accessStmt->bindValue($key, $value);
    }
    $accessStmt->bindValue(':limit', $accessSize, PDO::PARAM_INT);
    $accessStmt->bindValue(':offset', $accessOffset, PDO::PARAM_INT);
    $accessStmt->execute();
    $accessLogs = $accessStmt->fetchAll(PDO::FETCH_ASSOC);
    $accessQuery = $_GET;
    unset($accessQuery['access_page'], $accessQuery['access_size']);
    $accessFilterQuery = $accessQuery;
    unset($accessFilterQuery['access_share']);
    $accessSourceQuery = $_GET;
    unset($accessSourceQuery['access_source_page'], $accessSourceQuery['access_source_size']);
    $apiKey = flash('api_key');
    $info = flash('info');
    $error = flash('error');
    $content = '';
    if ($error) {
        $content .= '<div class="flash">' . htmlspecialchars($error) . '</div>';
    }
    if ($info) {
        $content .= '<div class="flash">' . htmlspecialchars($info) . '</div>';
    }
    if ((int)$user['must_change_password'] === 1) {
        $content .= '<div class="notice">检测到默认密码，请尽快在账号设置中修改。</div>';
    }
    $content .= '<div class="card"><h2>存储空间</h2>';
    $content .= '<p>已使用：' . format_bytes($usedBytes) . ' / ' . $limitLabel . '（' . $limitSource . '）</p>';
    $content .= '</div>';
    $content .= '<div class="card"><h2>API Key</h2>';
    if ($apiKey) {
        $content .= '<div class="notice">新的 API Key：<code>' . htmlspecialchars($apiKey) . '</code>（仅显示一次，请妥善保存）</div>';
    }
    if (!empty($user['api_key_last4'])) {
        $content .= '<p class="muted">当前 Key 末尾：' . htmlspecialchars($user['api_key_last4'] ?? '') . '</p>';
    } else {
        $content .= '<p class="muted">尚未生成 API Key。</p>';
    }
    $buttonLabel = !empty($user['api_key_last4']) ? '重新生成' : '生成 API Key';
    $content .= '<form method="post" action="' . base_path() . '/api-key/rotate">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<button class="button" type="submit">' . $buttonLabel . '</button>';
    $content .= '</form></div>';

    $content .= '<div class="card"><h2>账号设置</h2>';
    $content .= '<p class="muted">修改登录密码、查看账号状态。</p>';
    $content .= '<a class="button" href="' . base_path() . '/account">前往账号设置</a>';
    $content .= '</div>';

    $content .= '<div class="card" id="shares"><h2>分享列表</h2>';
    $content .= '<form method="get" action="' . base_path() . '/dashboard#shares" class="filter-form">';
    $content .= render_hidden_inputs($shareQuery);
    $content .= '<div class="grid">';
    $content .= '<div><label>关键词</label><input class="input" name="share_search" placeholder="标题 / Slug" value="' . htmlspecialchars($shareSearch) . '"></div>';
    $content .= '<div><label>状态筛选</label><select class="input" name="status">';
    $content .= '<option value="active"' . ($filterStatus === 'active' ? ' selected' : '') . '>正常</option>';
    $content .= '<option value="deleted"' . ($filterStatus === 'deleted' ? ' selected' : '') . '>已删除</option>';
    $content .= '<option value="all"' . ($filterStatus === 'all' ? ' selected' : '') . '>全部</option>';
    $content .= '</select></div>';
    $content .= '</div>';
    $content .= '<div style="margin-top:12px"><button class="button" type="submit">筛选</button></div>';
    $content .= '</form>';
    if (empty($shares)) {
        $content .= '<p class="muted" style="margin-top:12px">暂无分享记录。</p>';
    } else {
        $content .= '<table class="table" style="margin-top:12px"><thead><tr><th>标题</th><th>类型</th><th>链接</th><th>密码</th><th>到期</th><th>访客上限</th><th>状态</th><th>评论邮件通知</th><th>大小</th><th>更新时间</th></tr></thead><tbody>';
        foreach ($shares as $share) {
            $title = htmlspecialchars($share['title']);
            $type = $share['type'] === 'notebook' ? '笔记本' : '文档';
            $url = share_url($share['slug']);
            $updated = htmlspecialchars($share['updated_at']);
            $size = format_bytes((int)($share['size_bytes'] ?? 0));
            $hasPassword = !empty($share['password_hash']) ? '已设置' : '无';
            $expiresAt = !empty($share['expires_at']) ? date('Y-m-d H:i', (int)$share['expires_at']) : '永久';
            $visitorLimit = (int)($share['visitor_limit'] ?? 0);
            if ($visitorLimit > 0) {
                $visitorCount = share_visitor_count((int)$share['id']);
                $visitorLabel = $visitorCount . '/' . $visitorLimit;
            } else {
                $visitorLabel = '不限';
            }
            $status = $share['deleted_at'] ? '已删除' : '正常';
            $notifyEnabled = (int)($share['comment_notify'] ?? 0) === 1;
            if (!empty($share['deleted_at'])) {
                $notifyHtml = '<span class="muted">已删除</span>';
            } else {
                $notifyHtml = '<div class="comment-notify">';
                $notifyHtml .= '<span class="comment-notify-status">' . ($notifyEnabled ? '已开启' : '已关闭') . '</span>';
                if ($notifyEnabled || smtp_enabled()) {
                    $notifyHtml .= '<form method="post" action="' . base_path() . '/dashboard/comment-notify" class="inline-form">';
                    $notifyHtml .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
                    $notifyHtml .= '<input type="hidden" name="share_id" value="' . (int)$share['id'] . '">';
                    $notifyHtml .= '<input type="hidden" name="action" value="' . ($notifyEnabled ? 'disable' : 'enable') . '" data-toggle-action>';
                    $notifyHtml .= '<label class="switch">';
                    $notifyHtml .= '<input type="checkbox" ' . ($notifyEnabled ? 'checked ' : '') . 'data-toggle-input>';
                    $notifyHtml .= '<span class="switch-slider"></span>';
                    $notifyHtml .= '</label>';
                    $notifyHtml .= '</form>';
                } else {
                    $notifyHtml .= '<span class="muted">需开启SMTP</span>';
                    $notifyHtml .= '<label class="switch is-disabled">';
                    $notifyHtml .= '<input type="checkbox" disabled>';
                    $notifyHtml .= '<span class="switch-slider"></span>';
                    $notifyHtml .= '</label>';
                }
                $notifyHtml .= '</div>';
            }
            $content .= "<tr><td>{$title}</td><td>{$type}</td><td><a href=\"{$url}\" target=\"_blank\">{$url}</a></td><td>{$hasPassword}</td><td>{$expiresAt}</td><td>{$visitorLabel}</td><td>{$status}</td><td>{$notifyHtml}</td><td>{$size}</td><td>{$updated}</td></tr>";
        }
        $content .= '</tbody></table>';
    }
    $content .= '<div class="pagination">';
    $content .= '<a class="button ghost" href="' . build_dashboard_query_url(['share_page' => max(1, $sharePage - 1)]) . '">上一页</a>';
    $content .= '<div class="pagination-info">第 ' . $sharePage . ' / ' . $sharePages . ' 页，共 ' . $totalShares . ' 条分享</div>';
    $content .= '<a class="button ghost" href="' . build_dashboard_query_url(['share_page' => min($sharePages, $sharePage + 1)]) . '">下一页</a>';
    $content .= '<form method="get" action="' . base_path() . '/dashboard#shares" class="pagination-form">';
    $content .= render_hidden_inputs(array_merge($shareQuery, [
        'share_search' => $shareSearch,
        'status' => $filterStatus,
    ]));
    $content .= '<label>每页</label><select class="input" name="share_size">';
    foreach ([10, 50, 200, 1000] as $size) {
        $selected = $shareSize === $size ? ' selected' : '';
        $content .= '<option value="' . $size . '"' . $selected . '>' . $size . '</option>';
    }
    $content .= '</select>';
    $content .= '<label>页码</label><input class="input small" type="number" name="share_page" min="1" max="' . $sharePages . '" value="' . $sharePage . '">';
    $content .= '<button class="button" type="submit">跳转</button>';
    $content .= '</form>';
    $content .= '</div>';
    $content .= '</div>';

    $content .= '<div class="card" id="access-stats"><h2>访问概况</h2>';
    $content .= '<form method="post" action="' . base_path() . '/dashboard/access-stats/update" class="stats-settings">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<div class="grid">';
    $content .= '<div><label>访问统计</label><label class="checkbox stats-toggle"><input type="checkbox" name="access_enabled" value="1"' . ($accessEnabled ? ' checked' : '') . '> 开启</label></div>';
    $content .= '<div><label>保留天数</label><input class="input" type="number" name="access_retention_days" min="1" max="365" value="' . (int)$accessRetention . '"></div>';
    $content .= '</div>';
    $content .= '<div class="muted stats-note">访客数(UV) 按浏览器 Cookie 去重（按天），访问记录计入账号存储空间，默认保留最近 7 天（当前 ' . (int)$accessRetention . ' 天），可在此调整；存储不足会自动关闭并清空统计。</div>';
    if ($storageFull) {
        $content .= '<div class="notice" style="margin-top:8px">存储空间已满，当前无法开启访问统计，请先清理空间。</div>';
    }
    if (!$accessEnabled) {
        $content .= '<div class="notice" style="margin-top:8px">访问统计已关闭，当前不会记录新的访问。</div>';
    }
    $content .= '<div style="margin-top:12px"><button class="button" type="submit">保存设置</button></div>';
    $content .= '</form>';

    $content .= '<form method="get" action="' . base_path() . '/dashboard#access-stats" class="filter-form">';
    $content .= render_hidden_inputs($accessFilterQuery);
    $content .= '<div class="grid">';
    $content .= '<div><label>笔记筛选</label><select class="input" name="access_share">';
    $content .= '<option value="all"' . ($accessShareId <= 0 ? ' selected' : '') . '>全部</option>';
    foreach ($accessShareOptions as $option) {
        $optionId = (int)($option['id'] ?? 0);
        $optionTitle = (string)($option['title'] ?? '');
        $optionSlug = (string)($option['slug'] ?? '');
        $label = $optionTitle !== '' ? $optionTitle : $optionSlug;
        if ($optionSlug !== '') {
            $label .= ' /s/' . $optionSlug;
        }
        $selected = $accessShareId === $optionId ? ' selected' : '';
        $content .= '<option value="' . $optionId . '"' . $selected . '>' . htmlspecialchars($label) . '</option>';
    }
    $content .= '</select></div>';
    $content .= '</div>';
    $content .= '<div style="margin-top:12px"><button class="button" type="submit">筛选</button></div>';
    $content .= '</form>';

    $content .= '<div class="stats-block">';
    $content .= '<div class="stats-title">访问概况</div>';
    $content .= '<table class="table stats-table"><thead><tr><th></th><th>浏览量(PV)</th><th>访客数(UV)</th><th>IP 数量</th></tr></thead><tbody>';
    $content .= '<tr><td>今日</td><td>' . $accessSummary['pv_today'] . '</td><td>' . $accessSummary['uv_today'] . '</td><td>' . $accessSummary['ip_today'] . '</td></tr>';
    $content .= '<tr><td>昨日</td><td>' . $accessSummary['pv_yesterday'] . '</td><td>' . $accessSummary['uv_yesterday'] . '</td><td>' . $accessSummary['ip_yesterday'] . '</td></tr>';
    $content .= '<tr><td>总计</td><td>' . $accessSummary['pv_total'] . '</td><td>' . $accessSummary['uv_total'] . '</td><td>' . $accessSummary['ip_total'] . '</td></tr>';
    $content .= '</tbody></table>';
    $content .= '</div>';

    $content .= '<div class="stats-block">';
    $content .= '<div class="stats-title">来源页</div>';
    if (empty($accessSources)) {
        $content .= '<p class="muted">暂无来源数据。</p>';
    } else {
        $content .= '<table class="table stats-table"><thead><tr><th>排名</th><th>次数</th><th>来源地址</th></tr></thead><tbody>';
        $rank = 1;
        foreach ($accessSources as $row) {
            $referer = (string)($row['referer'] ?? '');
            $total = (int)($row['total'] ?? 0);
            $content .= '<tr><td>' . $rank . '</td><td>' . $total . '</td><td class="stats-source">' . htmlspecialchars($referer) . '</td></tr>';
            $rank++;
        }
        $content .= '</tbody></table>';
        $content .= '<div class="pagination">';
        $content .= '<a class="button ghost" href="' . build_access_stats_query_url(['access_source_page' => max(1, $accessSourcePage - 1)]) . '">上一页</a>';
        $content .= '<div class="pagination-info">第 ' . $accessSourcePage . ' / ' . $accessSourcePages . ' 页，共 ' . $accessSourceTotal . ' 条来源</div>';
        $content .= '<a class="button ghost" href="' . build_access_stats_query_url(['access_source_page' => min($accessSourcePages, $accessSourcePage + 1)]) . '">下一页</a>';
        $content .= '<form method="get" action="' . base_path() . '/dashboard#access-stats" class="pagination-form">';
        $content .= render_hidden_inputs(array_merge($accessSourceQuery, [
            'access_share' => $accessShareId > 0 ? $accessShareId : 'all',
        ]));
        $content .= '<label>每页</label><select class="input" name="access_source_size">';
        foreach ([10, 50, 200, 1000] as $size) {
            $selected = $accessSourceSize === $size ? ' selected' : '';
            $content .= '<option value="' . $size . '"' . $selected . '>' . $size . '</option>';
        }
        $content .= '</select>';
        $content .= '<label>页码</label><input class="input small" type="number" name="access_source_page" min="1" max="' . $accessSourcePages . '" value="' . $accessSourcePage . '">';
        $content .= '<button class="button" type="submit">跳转</button>';
        $content .= '</form>';
        $content .= '</div>';
    }
    $content .= '</div>';

    $content .= '<div class="stats-block">';
    $content .= '<div class="stats-title">访客地域分析</div>';
    $content .= '<div class="stats-charts">';
    $content .= '<div class="stats-chart">';
    $content .= '<div class="stats-subtitle">国内</div>';
    if (empty($accessRegionsCn)) {
        $content .= '<p class="muted">暂无数据。</p>';
    } else {
        $content .= '<div class="stats-chart-list">';
        foreach ($accessRegionsCn as $row) {
            $label = (string)($row['label'] ?? '');
            $total = (int)($row['total'] ?? 0);
            $percent = $accessCnMax > 0 ? round(($total / $accessCnMax) * 100, 1) : 0;
            $content .= '<div class="stats-chart-row"><div class="stats-label">' . htmlspecialchars($label) . '</div><div class="stats-bar-track"><div class="stats-bar" style="width:' . $percent . '%"></div></div><div class="stats-value">' . $total . '</div></div>';
        }
        $content .= '</div>';
    }
    $content .= '</div>';
    $content .= '<div class="stats-chart">';
    $content .= '<div class="stats-subtitle">国际</div>';
    if (empty($accessRegionsIntl)) {
        $content .= '<p class="muted">暂无数据。</p>';
    } else {
        $content .= '<div class="stats-chart-list">';
        foreach ($accessRegionsIntl as $row) {
            $label = (string)($row['label'] ?? '');
            $total = (int)($row['total'] ?? 0);
            $percent = $accessIntlMax > 0 ? round(($total / $accessIntlMax) * 100, 1) : 0;
            $content .= '<div class="stats-chart-row"><div class="stats-label">' . htmlspecialchars($label) . '</div><div class="stats-bar-track"><div class="stats-bar" style="width:' . $percent . '%"></div></div><div class="stats-value">' . $total . '</div></div>';
        }
        $content .= '</div>';
    }
    $content .= '</div>';
    $content .= '</div>';
    $content .= '</div>';

    $content .= '<div class="stats-block">';
    $content .= '<div class="stats-title">访问记录</div>';
    $content .= '<div class="table-actions stats-actions">';
    $content .= '<form id="access-batch-form" method="post" action="' . base_path() . '/dashboard/access-stats/delete" class="inline-form" data-batch-form="access">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<label class="checkbox"><input type="checkbox" data-check-all="access"> 全选</label>';
    $content .= '<button class="button danger" type="submit">批量删除</button>';
    $content .= '</form>';
    $content .= '<form method="post" action="' . base_path() . '/dashboard/access-stats/delete-all" class="inline-form" data-confirm-message="确定删除全部访问记录吗？该操作不可恢复。">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<button class="button danger" type="submit">删除全部（占用 ' . $accessLogTotalLabel . '）</button>';
    $content .= '</form>';
    $content .= '</div>';
    if (empty($accessLogs)) {
        $content .= '<p class="muted">暂无访问记录。</p>';
    } else {
        $content .= '<table class="table stats-table"><thead><tr><th><input type="checkbox" data-check-all="access" form="access-batch-form"></th><th>标题</th><th>IP</th><th>IP归属地</th><th>访问日期</th></tr></thead><tbody>';
        foreach ($accessLogs as $log) {
            $logTitle = trim((string)($log['doc_title'] ?? ''));
            if ($logTitle === '') {
                $logTitle = (string)($log['share_title'] ?? '');
            }
            if ($logTitle === '') {
                $logTitle = '未命名';
            }
            $slug = (string)($log['slug'] ?? '');
            $docId = trim((string)($log['doc_id'] ?? ''));
            if ($slug !== '') {
                $shareLink = $docId !== '' ? base_url() . build_share_redirect_path($slug, $docId, '') : share_url($slug);
                $suffix = $docId !== '' ? '/s/' . $slug . '/' . $docId : '/s/' . $slug;
            } else {
                $shareLink = '#';
                $suffix = '';
            }
            $ip = trim((string)($log['ip'] ?? ''));
            if ($ip === '') {
                $ip = '-';
            }
            $location = format_ip_location([
                'country' => $log['ip_country'] ?? '',
                'country_code' => $log['ip_country_code'] ?? '',
                'region' => $log['ip_region'] ?? '',
                'city' => $log['ip_city'] ?? '',
            ]);
            if ($location === '') {
                $location = '-';
            }
            $content .= '<tr>';
            $content .= '<td><input type="checkbox" name="access_ids[]" value="' . (int)$log['id'] . '" data-check-item="access" form="access-batch-form"></td>';
            $content .= '<td><a href="' . htmlspecialchars($shareLink) . '" target="_blank">' . htmlspecialchars($logTitle) . '</a>';
            if ($suffix !== '') {
                $content .= '<div class="muted">' . htmlspecialchars($suffix) . '</div>';
            }
            $content .= '</td>';
            $content .= '<td>' . htmlspecialchars($ip) . '</td>';
            $content .= '<td>' . htmlspecialchars($location) . '</td>';
            $content .= '<td>' . htmlspecialchars((string)($log['created_at'] ?? '')) . '</td>';
            $content .= '</tr>';
        }
        $content .= '</tbody></table>';
    }
    $content .= '<div class="pagination">';
    $content .= '<a class="button ghost" href="' . build_access_stats_query_url(['access_page' => max(1, $accessPage - 1)]) . '">上一页</a>';
    $content .= '<div class="pagination-info">第 ' . $accessPage . ' / ' . $accessPages . ' 页，共 ' . $accessTotal . ' 条访问</div>';
    $content .= '<a class="button ghost" href="' . build_access_stats_query_url(['access_page' => min($accessPages, $accessPage + 1)]) . '">下一页</a>';
    $content .= '<form method="get" action="' . base_path() . '/dashboard#access-stats" class="pagination-form">';
    $content .= render_hidden_inputs(array_merge($accessQuery, [
        'access_share' => $accessShareId > 0 ? $accessShareId : 'all',
    ]));
    $content .= '<label>每页</label><select class="input" name="access_size">';
    foreach ([10, 50, 200, 1000] as $size) {
        $selected = $accessSize === $size ? ' selected' : '';
        $content .= '<option value="' . $size . '"' . $selected . '>' . $size . '</option>';
    }
    $content .= '</select>';
    $content .= '<label>页码</label><input class="input small" type="number" name="access_page" min="1" max="' . $accessPages . '" value="' . $accessPage . '">';
    $content .= '<button class="button" type="submit">跳转</button>';
    $content .= '</form>';
    $content .= '</div>';
    $content .= '</div>';

    $content .= '</div>';

    if ($user['role'] === 'admin') {
        $content .= '<div class="card"><h2>管理员入口</h2>';
        $content .= '<a class="button" href="' . base_path() . '/admin-home">进入后台</a>';
        $content .= '</div>';
    }

    $titleHtml = build_topbar_title('控制台', $user);
    render_page('控制台', $content, $user, '', ['layout' => 'app', 'nav' => 'dashboard', 'title_html' => $titleHtml]);
}

if ($path === '/admin-home') {
    $admin = require_admin();
    $pdo = db();
    $totalUsers = (int)$pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
    $disabledUsers = (int)$pdo->query('SELECT COUNT(*) FROM users WHERE disabled = 1')->fetchColumn();
    $totalSharesAll = (int)$pdo->query('SELECT COUNT(*) FROM shares')->fetchColumn();
    $totalSharesActive = (int)$pdo->query('SELECT COUNT(*) FROM shares WHERE deleted_at IS NULL')->fetchColumn();
    $deletedShares = max(0, $totalSharesAll - $totalSharesActive);
    $totalAccess = (int)$pdo->query('SELECT COUNT(*) FROM share_access_logs')->fetchColumn();
    $totalUv = (int)$pdo->query('SELECT COUNT(DISTINCT visitor_id) FROM share_access_logs WHERE visitor_id IS NOT NULL AND visitor_id != ""')->fetchColumn();
    $todayStart = date('Y-m-d 00:00:00');
    $tomorrowStart = date('Y-m-d 00:00:00', strtotime('+1 day'));
    $todayStmt = $pdo->prepare('SELECT COUNT(*) AS pv, COUNT(DISTINCT CASE WHEN visitor_id IS NULL OR visitor_id = "" THEN NULL ELSE visitor_id END) AS uv
        FROM share_access_logs WHERE created_at >= :start AND created_at < :end');
    $todayStmt->execute([':start' => $todayStart, ':end' => $tomorrowStart]);
    $todayRow = $todayStmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $todayPv = (int)($todayRow['pv'] ?? 0);
    $todayUv = (int)($todayRow['uv'] ?? 0);
    $activeStart30 = date('Y-m-d H:i:s', strtotime('-30 days'));
    $activeStart7 = date('Y-m-d H:i:s', strtotime('-7 days'));
    $activeStmt = $pdo->prepare('SELECT COUNT(*) FROM users WHERE last_active_at >= :start');
    $activeStmt->execute([':start' => $activeStart30]);
    $activeUsers30 = (int)$activeStmt->fetchColumn();
    $activeStmt->execute([':start' => $activeStart7]);
    $activeUsers7 = (int)$activeStmt->fetchColumn();
    $shareBytes = (int)$pdo->query('SELECT COALESCE(SUM(size_bytes), 0) FROM shares WHERE deleted_at IS NULL')->fetchColumn();
    $logBytes = (int)$pdo->query('SELECT COALESCE(SUM(size_bytes), 0) FROM share_access_logs')->fetchColumn();
    $usedBytes = $shareBytes + $logBytes;
    $defaultLimitBytes = default_storage_limit_bytes();
    $limitStmt = $pdo->prepare('SELECT SUM(CASE WHEN storage_limit_bytes > 0 THEN storage_limit_bytes ELSE :default_limit END) AS total FROM users');
    $limitStmt->execute([':default_limit' => $defaultLimitBytes]);
    $totalLimitBytes = (int)($limitStmt->fetchColumn() ?: 0);
    if ($totalUsers === 0) {
        $totalLimitBytes = 0;
    }
    $remainingBytes = $totalLimitBytes > 0 ? max(0, $totalLimitBytes - $usedBytes) : 0;
    $storagePercent = $totalLimitBytes > 0 ? min(100, round($usedBytes / max(1, $totalLimitBytes) * 100, 1)) : 0;
    $commentTotal = (int)$pdo->query('SELECT COUNT(*) FROM share_comments')->fetchColumn();
    $commentStmt = $pdo->prepare('SELECT COUNT(*) FROM share_comments WHERE created_at >= :start');
    $commentStmt->execute([':start' => $activeStart7]);
    $commentNew7 = (int)$commentStmt->fetchColumn();
    $reportTotal = (int)$pdo->query('SELECT COUNT(*) FROM share_reports')->fetchColumn();
    $reportPending = (int)$pdo->query('SELECT COUNT(*) FROM share_reports WHERE handled_at IS NULL OR handled_at = ""')->fetchColumn();

    $range7 = build_date_range(7);
    $range30 = build_date_range(30);
    $range7Start = $range7[0] . ' 00:00:00';
    $range30Start = $range30[0] . ' 00:00:00';

    $accessDailySql = 'SELECT substr(created_at, 1, 10) AS day,
        COUNT(*) AS pv,
        COUNT(DISTINCT CASE WHEN visitor_id IS NULL OR visitor_id = "" THEN NULL ELSE visitor_id END) AS uv
        FROM share_access_logs WHERE created_at >= :start GROUP BY day ORDER BY day';
    $accessDailyStmt = $pdo->prepare($accessDailySql);
    $accessDailyStmt->execute([':start' => $range7Start]);
    $accessRows7 = $accessDailyStmt->fetchAll(PDO::FETCH_ASSOC);
    $accessDailyStmt->execute([':start' => $range30Start]);
    $accessRows30 = $accessDailyStmt->fetchAll(PDO::FETCH_ASSOC);
    $pvSeries7 = fill_series($range7, $accessRows7, 'pv');
    $uvSeries7 = fill_series($range7, $accessRows7, 'uv');
    $pvSeries30 = fill_series($range30, $accessRows30, 'pv');
    $uvSeries30 = fill_series($range30, $accessRows30, 'uv');

    $shareDailySql = 'SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS total FROM shares WHERE created_at >= :start GROUP BY day ORDER BY day';
    $shareDailyStmt = $pdo->prepare($shareDailySql);
    $shareDailyStmt->execute([':start' => $range7Start]);
    $shareRows7 = $shareDailyStmt->fetchAll(PDO::FETCH_ASSOC);
    $shareDailyStmt->execute([':start' => $range30Start]);
    $shareRows30 = $shareDailyStmt->fetchAll(PDO::FETCH_ASSOC);
    $shareSeries7 = fill_series($range7, $shareRows7, 'total');
    $shareSeries30 = fill_series($range30, $shareRows30, 'total');

    $userDailySql = 'SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS total FROM users WHERE created_at >= :start GROUP BY day ORDER BY day';
    $userDailyStmt = $pdo->prepare($userDailySql);
    $userDailyStmt->execute([':start' => $range7Start]);
    $userRows7 = $userDailyStmt->fetchAll(PDO::FETCH_ASSOC);
    $userDailyStmt->execute([':start' => $range30Start]);
    $userRows30 = $userDailyStmt->fetchAll(PDO::FETCH_ASSOC);
    $userSeries7 = fill_series($range7, $userRows7, 'total');
    $userSeries30 = fill_series($range30, $userRows30, 'total');

    $shareBytesSql = 'SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(size_bytes), 0) AS total
        FROM shares WHERE created_at >= :start AND deleted_at IS NULL GROUP BY day ORDER BY day';
    $logBytesSql = 'SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(size_bytes), 0) AS total
        FROM share_access_logs WHERE created_at >= :start GROUP BY day ORDER BY day';
    $shareBytesStmt = $pdo->prepare($shareBytesSql);
    $logBytesStmt = $pdo->prepare($logBytesSql);
    $shareBytesStmt->execute([':start' => $range7Start]);
    $shareBytesRows7 = $shareBytesStmt->fetchAll(PDO::FETCH_ASSOC);
    $logBytesStmt->execute([':start' => $range7Start]);
    $logBytesRows7 = $logBytesStmt->fetchAll(PDO::FETCH_ASSOC);
    $shareBytesStmt->execute([':start' => $range30Start]);
    $shareBytesRows30 = $shareBytesStmt->fetchAll(PDO::FETCH_ASSOC);
    $logBytesStmt->execute([':start' => $range30Start]);
    $logBytesRows30 = $logBytesStmt->fetchAll(PDO::FETCH_ASSOC);
    $shareBytesSeries7 = fill_series($range7, $shareBytesRows7, 'total');
    $logBytesSeries7 = fill_series($range7, $logBytesRows7, 'total');
    $shareBytesSeries30 = fill_series($range30, $shareBytesRows30, 'total');
    $logBytesSeries30 = fill_series($range30, $logBytesRows30, 'total');
    $storageBytesSeries7 = [];
    $storageBytesSeries30 = [];
    foreach ($shareBytesSeries7 as $index => $value) {
        $storageBytesSeries7[] = $value + ($logBytesSeries7[$index] ?? 0);
    }
    foreach ($shareBytesSeries30 as $index => $value) {
        $storageBytesSeries30[] = $value + ($logBytesSeries30[$index] ?? 0);
    }
    $storageSeries7 = array_map(fn($value) => round($value / 1024 / 1024, 2), $storageBytesSeries7);
    $storageSeries30 = array_map(fn($value) => round($value / 1024 / 1024, 2), $storageBytesSeries30);
    $pvTotal7 = array_sum($pvSeries7);
    $uvTotal7 = array_sum($uvSeries7);
    $pvTotal30 = array_sum($pvSeries30);
    $uvTotal30 = array_sum($uvSeries30);
    $shareTotal7 = array_sum($shareSeries7);
    $shareTotal30 = array_sum($shareSeries30);
    $userTotal7 = array_sum($userSeries7);
    $userTotal30 = array_sum($userSeries30);
    $storageTotal7 = array_sum($storageBytesSeries7);
    $storageTotal30 = array_sum($storageBytesSeries30);

    $pvUvSeries7Chart = [
        ['key' => 'pv', 'values' => $pvSeries7, 'lineClass' => 'chart-line chart-line--primary', 'areaClass' => 'chart-area chart-area--primary'],
        ['key' => 'uv', 'values' => $uvSeries7, 'lineClass' => 'chart-line chart-line--accent'],
    ];
    $pvUvSeries30Chart = [
        ['key' => 'pv', 'values' => $pvSeries30, 'lineClass' => 'chart-line chart-line--primary', 'areaClass' => 'chart-area chart-area--primary'],
        ['key' => 'uv', 'values' => $uvSeries30, 'lineClass' => 'chart-line chart-line--accent'],
    ];
    $shareSeries7Chart = [
        ['key' => 'share', 'values' => $shareSeries7, 'lineClass' => 'chart-line chart-line--secondary', 'areaClass' => 'chart-area chart-area--secondary'],
    ];
    $shareSeries30Chart = [
        ['key' => 'share', 'values' => $shareSeries30, 'lineClass' => 'chart-line chart-line--secondary', 'areaClass' => 'chart-area chart-area--secondary'],
    ];
    $userSeries7Chart = [
        ['key' => 'user', 'values' => $userSeries7, 'lineClass' => 'chart-line chart-line--info', 'areaClass' => 'chart-area chart-area--info'],
    ];
    $userSeries30Chart = [
        ['key' => 'user', 'values' => $userSeries30, 'lineClass' => 'chart-line chart-line--info', 'areaClass' => 'chart-area chart-area--info'],
    ];
    $storageSeries7Chart = [
        [
            'key' => 'storage',
            'values' => $storageSeries7,
            'lineClass' => 'chart-line chart-line--storage',
            'areaClass' => 'chart-area chart-area--storage',
            'sumValues' => $storageBytesSeries7,
            'sumFormat' => 'bytes',
        ],
    ];
    $storageSeries30Chart = [
        [
            'key' => 'storage',
            'values' => $storageSeries30,
            'lineClass' => 'chart-line chart-line--storage',
            'areaClass' => 'chart-area chart-area--storage',
            'sumValues' => $storageBytesSeries30,
            'sumFormat' => 'bytes',
        ],
    ];

    $pvUvChart7 = render_chart_svg([
        ['values' => $pvSeries7, 'line_class' => 'chart-line chart-line--primary', 'area_class' => 'chart-area chart-area--primary'],
        ['values' => $uvSeries7, 'line_class' => 'chart-line chart-line--accent'],
    ]);
    $pvUvChart30 = render_chart_svg([
        ['values' => $pvSeries30, 'line_class' => 'chart-line chart-line--primary', 'area_class' => 'chart-area chart-area--primary'],
        ['values' => $uvSeries30, 'line_class' => 'chart-line chart-line--accent'],
    ]);
    $shareChart7 = render_chart_svg([
        ['values' => $shareSeries7, 'line_class' => 'chart-line chart-line--secondary', 'area_class' => 'chart-area chart-area--secondary'],
    ]);
    $shareChart30 = render_chart_svg([
        ['values' => $shareSeries30, 'line_class' => 'chart-line chart-line--secondary', 'area_class' => 'chart-area chart-area--secondary'],
    ]);
    $userChart7 = render_chart_svg([
        ['values' => $userSeries7, 'line_class' => 'chart-line chart-line--info', 'area_class' => 'chart-area chart-area--info'],
    ]);
    $userChart30 = render_chart_svg([
        ['values' => $userSeries30, 'line_class' => 'chart-line chart-line--info', 'area_class' => 'chart-area chart-area--info'],
    ]);
    $storageChart7 = render_chart_svg([
        ['values' => $storageSeries7, 'line_class' => 'chart-line chart-line--storage', 'area_class' => 'chart-area chart-area--storage'],
    ]);
    $storageChart30 = render_chart_svg([
        ['values' => $storageSeries30, 'line_class' => 'chart-line chart-line--storage', 'area_class' => 'chart-area chart-area--storage'],
    ]);

    $pvUvHolder7 = render_admin_chart_holder($range7, $pvUvSeries7Chart, 'count', $pvUvChart7);
    $pvUvHolder30 = render_admin_chart_holder($range30, $pvUvSeries30Chart, 'count', $pvUvChart30);
    $shareHolder7 = render_admin_chart_holder($range7, $shareSeries7Chart, 'count', $shareChart7);
    $shareHolder30 = render_admin_chart_holder($range30, $shareSeries30Chart, 'count', $shareChart30);
    $userHolder7 = render_admin_chart_holder($range7, $userSeries7Chart, 'count', $userChart7);
    $userHolder30 = render_admin_chart_holder($range30, $userSeries30Chart, 'count', $userChart30);
    $storageHolder7 = render_admin_chart_holder($range7, $storageSeries7Chart, 'MB', $storageChart7);
    $storageHolder30 = render_admin_chart_holder($range30, $storageSeries30Chart, 'MB', $storageChart30);

    $instanceStats = fetch_central_instance_stats();
    $instanceTotal = $instanceStats ? (int)($instanceStats['total'] ?? 0) : null;
    $instanceActive30 = $instanceStats ? (int)($instanceStats['active_30'] ?? 0) : null;
    $instanceUpdatedAt = $instanceStats ? (string)($instanceStats['updated_at'] ?? '') : '';

    $greetingLabel = '你好';
    $hour = (int)date('G');
    if ($hour < 6) {
        $greetingLabel = '凌晨好';
    } elseif ($hour < 12) {
        $greetingLabel = '上午好';
    } elseif ($hour < 18) {
        $greetingLabel = '下午好';
    } else {
        $greetingLabel = '晚上好';
    }
    $adminName = htmlspecialchars((string)($admin['username'] ?? ''));
    $greeting = $greetingLabel . '，' . $adminName;

    $content = '<section class="admin-home">';
    $content .= '<div class="admin-hero card">';
    $content .= '<div class="admin-hero__main">';
    $content .= '<div class="admin-hero__eyebrow">数据统计</div>';
    $content .= '<div class="admin-hero__title">' . $greeting . '</div>';
    $content .= '<div class="admin-hero__meta">今日访问 浏览量(PV) ' . number_format($todayPv) . ' / 访客数(UV) ' . number_format($todayUv) . '</div>';
    $content .= '</div>';
    $content .= '<div class="admin-hero__aside">';
    $content .= '<div class="admin-hero__panel">';
    $content .= '<div class="admin-hero__panel-label">系统在用实例</div>';
    if ($instanceTotal === null) {
        $content .= '<div class="admin-hero__panel-value">—</div>';
        $content .= '<div class="admin-hero__panel-meta muted">统计暂不可用</div>';
    } else {
        $content .= '<div class="admin-hero__panel-value">' . number_format($instanceTotal) . '</div>';
        $content .= '<div class="admin-hero__panel-meta">30天活跃 ' . number_format($instanceActive30 ?? 0) . '</div>';
        if ($instanceUpdatedAt !== '') {
            $content .= '<div class="admin-hero__panel-sub muted">更新时间 ' . htmlspecialchars($instanceUpdatedAt) . '</div>';
        }
    }
    $content .= '</div>';
    $content .= '</div>';
    $content .= '</div>';

    $iconUser = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-4 0-7 2-7 4.5V20h14v-1.5C19 16 16 14 12 14z"/></svg>';
    $iconActive = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 12h4l2-5 4 10 2-5h4v2h-3l-3 7-4-10-2 5H3z"/></svg>';
    $iconShare = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18 8a3 3 0 1 0-2.83-4H15a3 3 0 0 0 0 4 2.96 2.96 0 0 0 1 .19zM6 14a3 3 0 1 0 2.83 4H9a3 3 0 0 0 0-4 2.96 2.96 0 0 0-1-.19zM18 20a3 3 0 1 0-2.83-4H15a3 3 0 0 0 0 4 2.96 2.96 0 0 0 1 .19zM8.41 12.59l7.18 3.59.9-1.79-7.18-3.59-.9 1.79zM15.59 9.59l-7.18 3.59.9 1.79 7.18-3.59-.9-1.79z"/></svg>';
    $iconAccess = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 5c5.5 0 9.5 5.5 9.5 7s-4 7-9.5 7S2.5 14.5 2.5 12 6.5 5 12 5zm0 3a4 4 0 1 0 4 4 4 4 0 0 0-4-4z"/></svg>';
    $iconStorage = '<svg class="kpi-icon kpi-icon--storage" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 6c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2zm0 4c0 1.1 3.6 2 8 2s8-.9 8-2V8c-1.7 1.2-5.1 2-8 2s-6.3-.8-8-2zm0 4c0 1.1 3.6 2 8 2s8-.9 8-2v-2c-1.7 1.2-5.1 2-8 2s-6.3-.8-8-2zm0 4c0 1.1 3.6 2 8 2s8-.9 8-2v-2c-1.7 1.2-5.1 2-8 2s-6.3-.8-8-2z"/></svg>';

    $storageValue = format_bytes($usedBytes) . ($totalLimitBytes > 0 ? ' / ' . format_bytes($totalLimitBytes) : '');
    $storageMeta = $totalLimitBytes > 0 ? '剩余 ' . format_bytes($remainingBytes) : '总量不限';
    $storageProgress = '<div class="admin-kpi__progress"><span style="width:' . $storagePercent . '%"></span></div>';

    $content .= '<div class="admin-kpi-grid">';
    $content .= render_kpi_card('总用户', number_format($totalUsers), '含禁用 ' . number_format($disabledUsers), $iconUser);
    $content .= render_kpi_card('活跃用户', number_format($activeUsers30), '近7天 ' . number_format($activeUsers7), $iconActive);
    $content .= render_kpi_card('总分享', number_format($totalSharesActive), '已软删除 ' . number_format($deletedShares), $iconShare);
    $content .= render_kpi_card('总访问', number_format($totalAccess), '访客数(UV) 总计 ' . number_format($totalUv), $iconAccess);
    $content .= render_kpi_card('存储占用/剩余', htmlspecialchars($storageValue), htmlspecialchars($storageMeta), $iconStorage, $storageProgress);
    $content .= '</div>';

    $pvUvRangeSource = htmlspecialchars(json_encode([
        'labels' => $range30,
        'series' => $pvUvSeries30Chart,
        'unit' => 'count',
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), ENT_QUOTES);
    $shareRangeSource = htmlspecialchars(json_encode([
        'labels' => $range30,
        'series' => $shareSeries30Chart,
        'unit' => 'count',
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), ENT_QUOTES);
    $userRangeSource = htmlspecialchars(json_encode([
        'labels' => $range30,
        'series' => $userSeries30Chart,
        'unit' => 'count',
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), ENT_QUOTES);
    $storageRangeSource = htmlspecialchars(json_encode([
        'labels' => $range30,
        'series' => $storageSeries30Chart,
        'unit' => 'MB',
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), ENT_QUOTES);

    $content .= '<div class="admin-chart-grid">';
    $content .= '<div class="admin-chart-card" data-range-switch data-range-default="7" data-range-source="' . $pvUvRangeSource . '">';
    $content .= '<div class="admin-chart-card__head">';
    $content .= '<div><div class="admin-chart-card__title">PV/UV 走势</div><div class="admin-chart-card__meta" data-range-label>近7天</div></div>';
    $content .= '<div class="range-toggle">';
    $content .= '<button class="range-btn is-active" type="button" data-range-value="7">7天</button>';
    $content .= '<button class="range-btn" type="button" data-range-value="30">30天</button>';
    $content .= '<button class="range-btn" type="button" data-range-value="custom">自定义</button>';
    $content .= '</div></div>';
    $content .= '<div class="admin-chart-card__body">';
    $content .= '<div class="admin-chart-panel" data-range-panel="7">';
    $content .= '<div class="admin-chart-summary"><div class="admin-legend"><span class="legend-dot is-primary"></span>浏览量(PV) ' . number_format($pvTotal7) . '</div>';
    $content .= '<div class="admin-legend"><span class="legend-dot is-accent"></span>访客数(UV) ' . number_format($uvTotal7) . '</div></div>';
    $content .= $pvUvHolder7 . '</div>';
    $content .= '<div class="admin-chart-panel" data-range-panel="30" hidden>';
    $content .= '<div class="admin-chart-summary"><div class="admin-legend"><span class="legend-dot is-primary"></span>浏览量(PV) ' . number_format($pvTotal30) . '</div>';
    $content .= '<div class="admin-legend"><span class="legend-dot is-accent"></span>访客数(UV) ' . number_format($uvTotal30) . '</div></div>';
    $content .= $pvUvHolder30 . '</div>';
    $content .= '<div class="admin-chart-panel" data-range-panel="custom" hidden>';
    $content .= '<div class="admin-chart-summary"><div class="admin-legend"><span class="legend-dot is-primary"></span>浏览量(PV) <span data-range-metric="pv">0</span></div>';
    $content .= '<div class="admin-legend"><span class="legend-dot is-accent"></span>访客数(UV) <span data-range-metric="uv">0</span></div></div>';
    $content .= $pvUvHolder30;
    $content .= '<div class="range-slider"><input type="range" min="1" max="30" value="7" data-range-slider><div class="range-slider__value">最近 <span data-range-days>7</span> 天</div></div>';
    $content .= '</div>';
    $content .= '</div>';
    $content .= '</div>';

    $content .= '<div class="admin-chart-card" data-range-switch data-range-default="7" data-range-source="' . $shareRangeSource . '">';
    $content .= '<div class="admin-chart-card__head">';
    $content .= '<div><div class="admin-chart-card__title">分享新增量</div><div class="admin-chart-card__meta" data-range-label>近7天</div></div>';
    $content .= '<div class="range-toggle">';
    $content .= '<button class="range-btn is-active" type="button" data-range-value="7">7天</button>';
    $content .= '<button class="range-btn" type="button" data-range-value="30">30天</button>';
    $content .= '<button class="range-btn" type="button" data-range-value="custom">自定义</button>';
    $content .= '</div></div>';
    $content .= '<div class="admin-chart-card__body">';
    $content .= '<div class="admin-chart-panel" data-range-panel="7">';
    $content .= '<div class="admin-chart-summary muted">期间新增 ' . number_format($shareTotal7) . ' 条</div>';
    $content .= $shareHolder7 . '</div>';
    $content .= '<div class="admin-chart-panel" data-range-panel="30" hidden>';
    $content .= '<div class="admin-chart-summary muted">期间新增 ' . number_format($shareTotal30) . ' 条</div>';
    $content .= $shareHolder30 . '</div>';
    $content .= '<div class="admin-chart-panel" data-range-panel="custom" hidden>';
    $content .= '<div class="admin-chart-summary muted">期间新增 <span data-range-total>0</span> 条</div>';
    $content .= $shareHolder30;
    $content .= '<div class="range-slider"><input type="range" min="1" max="30" value="7" data-range-slider><div class="range-slider__value">最近 <span data-range-days>7</span> 天</div></div>';
    $content .= '</div>';
    $content .= '</div>';
    $content .= '</div>';

    $content .= '<div class="admin-chart-card" data-range-switch data-range-default="7" data-range-source="' . $userRangeSource . '">';
    $content .= '<div class="admin-chart-card__head">';
    $content .= '<div><div class="admin-chart-card__title">用户新增量</div><div class="admin-chart-card__meta" data-range-label>近7天</div></div>';
    $content .= '<div class="range-toggle">';
    $content .= '<button class="range-btn is-active" type="button" data-range-value="7">7天</button>';
    $content .= '<button class="range-btn" type="button" data-range-value="30">30天</button>';
    $content .= '<button class="range-btn" type="button" data-range-value="custom">自定义</button>';
    $content .= '</div></div>';
    $content .= '<div class="admin-chart-card__body">';
    $content .= '<div class="admin-chart-panel" data-range-panel="7">';
    $content .= '<div class="admin-chart-summary muted">期间新增 ' . number_format($userTotal7) . ' 人</div>';
    $content .= $userHolder7 . '</div>';
    $content .= '<div class="admin-chart-panel" data-range-panel="30" hidden>';
    $content .= '<div class="admin-chart-summary muted">期间新增 ' . number_format($userTotal30) . ' 人</div>';
    $content .= $userHolder30 . '</div>';
    $content .= '<div class="admin-chart-panel" data-range-panel="custom" hidden>';
    $content .= '<div class="admin-chart-summary muted">期间新增 <span data-range-total>0</span> 人</div>';
    $content .= $userHolder30;
    $content .= '<div class="range-slider"><input type="range" min="1" max="30" value="7" data-range-slider><div class="range-slider__value">最近 <span data-range-days>7</span> 天</div></div>';
    $content .= '</div>';
    $content .= '</div>';
    $content .= '</div>';

    $content .= '<div class="admin-chart-card" data-range-switch data-range-default="7" data-range-source="' . $storageRangeSource . '">';
    $content .= '<div class="admin-chart-card__head">';
    $content .= '<div><div class="admin-chart-card__title">存储增长</div><div class="admin-chart-card__meta" data-range-label>近7天</div></div>';
    $content .= '<div class="range-toggle">';
    $content .= '<button class="range-btn is-active" type="button" data-range-value="7">7天</button>';
    $content .= '<button class="range-btn" type="button" data-range-value="30">30天</button>';
    $content .= '<button class="range-btn" type="button" data-range-value="custom">自定义</button>';
    $content .= '</div></div>';
    $content .= '<div class="admin-chart-card__body">';
    $content .= '<div class="admin-chart-panel" data-range-panel="7">';
    $content .= '<div class="admin-chart-summary muted">期间增长 ' . htmlspecialchars(format_bytes($storageTotal7)) . '</div>';
    $content .= $storageHolder7 . '</div>';
    $content .= '<div class="admin-chart-panel" data-range-panel="30" hidden>';
    $content .= '<div class="admin-chart-summary muted">期间增长 ' . htmlspecialchars(format_bytes($storageTotal30)) . '</div>';
    $content .= $storageHolder30 . '</div>';
    $content .= '<div class="admin-chart-panel" data-range-panel="custom" hidden>';
    $content .= '<div class="admin-chart-summary muted">期间增长 <span data-range-total>0</span></div>';
    $content .= $storageHolder30;
    $content .= '<div class="range-slider"><input type="range" min="1" max="30" value="7" data-range-slider><div class="range-slider__value">最近 <span data-range-days>7</span> 天</div></div>';
    $content .= '</div>';
    $content .= '</div>';
    $content .= '</div>';
    $content .= '</div>';

    $content .= '<div class="admin-governance-grid">';
    $content .= '<div class="admin-governance card">';
    $content .= '<div class="admin-governance__label">评论总量</div>';
    $content .= '<div class="admin-governance__value">' . number_format($commentTotal) . '</div>';
    $content .= '<div class="admin-governance__meta">近7天新增 ' . number_format($commentNew7) . '</div>';
    $content .= '</div>';
    $content .= '<div class="admin-governance card">';
    $content .= '<div class="admin-governance__label">举报总量</div>';
    $content .= '<div class="admin-governance__value">' . number_format($reportTotal) . '</div>';
    $content .= '<div class="admin-governance__meta">待处理 ' . number_format($reportPending) . '</div>';
    $content .= '</div>';
    $content .= '</div>';
    $content .= '</section>';

    $titleHtml = build_topbar_title('数据统计', $admin);
    render_page('数据统计', $content, $admin, '', ['layout' => 'app', 'nav' => 'admin-home', 'title_html' => $titleHtml]);
}

if ($path === '/api-key/rotate' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $user = require_login();
    check_csrf();
    [$rawKey, $hash, $prefix, $last4] = generate_api_key();
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE users SET api_key_hash = :hash, api_key_prefix = :prefix, api_key_last4 = :last4, updated_at = :updated_at WHERE id = :id');
    $stmt->execute([
        ':hash' => $hash,
        ':prefix' => $prefix,
        ':last4' => $last4,
        ':updated_at' => now(),
        ':id' => $user['id'],
    ]);
    flash('api_key', $rawKey);
    redirect('/dashboard');
}

if ($path === '/dashboard/comment-notify' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $user = require_login();
    check_csrf();
    $shareId = (int)($_POST['share_id'] ?? 0);
    $action = (string)($_POST['action'] ?? '');
    if ($shareId <= 0 || !in_array($action, ['enable', 'disable'], true)) {
        flash('error', '请求参数错误');
        redirect('/dashboard#shares');
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT id FROM shares WHERE id = :id AND user_id = :uid AND deleted_at IS NULL');
    $stmt->execute([':id' => $shareId, ':uid' => $user['id']]);
    if (!$stmt->fetchColumn()) {
        flash('error', '分享不存在');
        redirect('/dashboard#shares');
    }
    $enable = $action === 'enable';
    if ($enable && !smtp_enabled()) {
        flash('error', '请先在后台开启 SMTP，再启用评论邮件通知');
        redirect('/dashboard#shares');
    }
    $update = $pdo->prepare('UPDATE shares SET comment_notify = :notify WHERE id = :id AND user_id = :uid');
    $update->execute([
        ':notify' => $enable ? 1 : 0,
        ':id' => $shareId,
        ':uid' => $user['id'],
    ]);
    flash('info', $enable ? '已开启评论邮件通知' : '已关闭评论邮件通知');
    redirect('/dashboard#shares');
}

if ($path === '/dashboard/access-stats/update' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $user = require_login();
    check_csrf();
    $userId = (int)$user['id'];
    $enabled = !empty($_POST['access_enabled']);
    $daysRaw = (int)($_POST['access_retention_days'] ?? access_stats_retention_days($userId));
    $days = max(1, min(365, $daysRaw));
    set_user_setting($userId, 'access_stats_retention_days', (string)$days);
    if ($enabled) {
        $used = recalculate_user_storage($userId);
        $limit = get_user_limit_bytes($user);
        if ($limit > 0 && $used >= $limit) {
            set_user_setting($userId, 'access_stats_enabled', '0');
            flash('error', '存储空间已满，无法开启访问统计');
            redirect('/dashboard#access-stats');
        }
        set_user_setting($userId, 'access_stats_enabled', '1');
    } else {
        set_user_setting($userId, 'access_stats_enabled', '0');
    }
    flash('info', '访问统计设置已更新');
    redirect('/dashboard#access-stats');
}

if ($path === '/dashboard/access-stats/delete' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $user = require_login();
    check_csrf();
    $userId = (int)$user['id'];
    $ids = $_POST['access_ids'] ?? [];
    $ids = is_array($ids) ? array_values(array_filter($ids)) : [];
    if (empty($ids)) {
        redirect('/dashboard#access-stats');
    }
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $pdo = db();
    $sumStmt = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM share_access_logs WHERE user_id = ? AND id IN (' . $placeholders . ')');
    $sumStmt->execute(array_merge([$userId], $ids));
    $total = (int)($sumStmt->fetch(PDO::FETCH_ASSOC)['total'] ?? 0);
    $delStmt = $pdo->prepare('DELETE FROM share_access_logs WHERE user_id = ? AND id IN (' . $placeholders . ')');
    $delStmt->execute(array_merge([$userId], $ids));
    adjust_user_storage($userId, -$total);
    flash('info', '已删除选中的访问记录');
    redirect('/dashboard#access-stats');
}

if ($path === '/dashboard/access-stats/delete-all' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $user = require_login();
    check_csrf();
    $userId = (int)$user['id'];
    purge_user_access_logs($userId);
    flash('info', '已清空全部访问记录');
    redirect('/dashboard#access-stats');
}

if ($path === '/admin') {
    $admin = require_admin();
    $pdo = db();
    $info = flash('info');
    $error = flash('error');
    $createForm = $_SESSION['user_create_form'] ?? [];
    if (!is_array($createForm)) {
        $createForm = [];
    }
    $createOpen = !empty($createForm['open']);
    $createUsername = (string)($createForm['username'] ?? '');
    $createEmail = (string)($createForm['email'] ?? '');
    $createRole = (string)($createForm['role'] ?? 'user');
    if (!in_array($createRole, ['admin', 'user'], true)) {
        $createRole = 'user';
    }
    $createDisabled = (string)($createForm['disabled'] ?? '0');
    $createLimitMb = (string)($createForm['limit_mb'] ?? '0');
    $createPassword = (string)($createForm['password'] ?? '');
    unset($_SESSION['user_create_form']);
    $allowRegistration = allow_registration();
    $captchaEnabled = captcha_enabled();
    $emailVerifyEnabled = email_verification_enabled();
    $defaultLimitBytes = default_storage_limit_bytes();
    $defaultLimitMb = mb_from_bytes($defaultLimitBytes);
    $emailFrom = get_setting('email_from', 'no-reply@example.com');
    $emailFromName = get_setting('email_from_name', '思源笔记分享');
    $emailSubject = get_setting('email_subject', '邮箱验证码');
    $emailResetSubject = get_setting('email_reset_subject', '重置密码验证码');
    $smtpEnabled = smtp_enabled();
    $smtpHost = get_setting('smtp_host', '');
    $smtpPort = get_setting('smtp_port', '587');
    $smtpSecure = get_setting('smtp_secure', 'tls');
    $smtpUser = get_setting('smtp_user', '');
    $smtpPass = get_setting('smtp_pass', '');
    $siteIcp = get_setting('site_icp', '');
    $siteContactEmail = get_setting('site_contact_email', '');
    $siteBaseUrl = get_setting('site_base_url', '');
    $bannedWordsRaw = get_banned_words_raw();
    $scanKeep = ((string)($_GET['scan_keep'] ?? '')) === '1';
    if (!$scanKeep) {
        unset($_SESSION['scan_results'], $_SESSION['scan_logs'], $_SESSION['scan_done'], $_SESSION['scan_at'], $_SESSION['scan_total']);
    }
    $scanResults = $_SESSION['scan_results'] ?? [];
    $scanAt = (int)($_SESSION['scan_at'] ?? 0);
    $scanResults = is_array($scanResults) ? $scanResults : [];
    $scanLogs = $_SESSION['scan_logs'] ?? [];
    $scanLogs = is_array($scanLogs) ? $scanLogs : [];
    $scanDone = (int)($_SESSION['scan_done'] ?? 0) === 1;
    $scanPage = max(1, (int)($_GET['scan_page'] ?? 1));
    $scanSize = normalize_page_size($_GET['scan_size'] ?? 10);
    $scanTotal = count($scanResults);
    $scanKeepParam = (!empty($scanLogs) || $scanTotal > 0) ? '1' : null;
    $scanLogHtml = '';
    foreach ($scanLogs as $log) {
        $scanLogHtml .= '<div>' . $log . '</div>';
    }
    $scanProgressHidden = $scanLogHtml === '' ? ' hidden' : '';
    $scanReady = $scanDone || $scanLogHtml !== '';
    $scanStatusLabel = $scanReady ? ('扫描完成，共命中 ' . number_format($scanTotal) . ' 条记录') : '等待扫描...';
    $scanBarStyle = $scanReady ? ' style="width:100%"' : '';
    [$scanPage, $scanSize, $scanPages, $scanOffset] = paginate($scanTotal, $scanPage, $scanSize);
    $scanPageResults = array_slice($scanResults, $scanOffset, $scanSize);
    [$chunkTtlSeconds] = chunk_cleanup_settings();
    $staleChunks = list_stale_chunks($chunkTtlSeconds);
    $allUsers = $pdo->query('SELECT id, username FROM users ORDER BY username ASC')->fetchAll(PDO::FETCH_ASSOC);
    $userSearch = trim((string)($_GET['user_search'] ?? ''));
    $userStatus = (string)($_GET['user_status'] ?? 'all');
    $userRole = (string)($_GET['user_role'] ?? 'all');
    $userPage = max(1, (int)($_GET['user_page'] ?? 1));
    $userSize = normalize_page_size($_GET['user_size'] ?? 10);
    $userWhere = [];
    $userParams = [];
    if ($userSearch !== '') {
        $userWhere[] = '(username LIKE :user_search OR email LIKE :user_search)';
        $userParams[':user_search'] = '%' . $userSearch . '%';
    }
    if ($userStatus === 'active') {
        $userWhere[] = 'disabled = 0';
    } elseif ($userStatus === 'disabled') {
        $userWhere[] = 'disabled = 1';
    }
    if ($userRole === 'admin') {
        $userWhere[] = 'role = "admin"';
    } elseif ($userRole === 'user') {
        $userWhere[] = 'role = "user"';
    }
    $userSql = 'SELECT * FROM users';
    $userCountSql = 'SELECT COUNT(*) FROM users';
    if (!empty($userWhere)) {
        $userSql .= ' WHERE ' . implode(' AND ', $userWhere);
        $userCountSql .= ' WHERE ' . implode(' AND ', $userWhere);
    }
    $userCountStmt = $pdo->prepare($userCountSql);
    $userCountStmt->execute($userParams);
    $totalUsers = (int)$userCountStmt->fetchColumn();
    [$userPage, $userSize, $userPages, $userOffset] = paginate($totalUsers, $userPage, $userSize);
    $userSql .= ' ORDER BY created_at DESC LIMIT :limit OFFSET :offset';
    $userStmt = $pdo->prepare($userSql);
    foreach ($userParams as $key => $value) {
        $userStmt->bindValue($key, $value);
    }
    $userStmt->bindValue(':limit', $userSize, PDO::PARAM_INT);
    $userStmt->bindValue(':offset', $userOffset, PDO::PARAM_INT);
    $userStmt->execute();
    $users = $userStmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($users as &$u) {
        $u['storage_used_bytes'] = recalculate_user_storage((int)$u['id']);
    }
    unset($u);

    $filterUser = (int)($_GET['user'] ?? 0);
    $filterStatus = (string)($_GET['status'] ?? 'active');
    $shareSearch = trim((string)($_GET['share_search'] ?? ''));
    $sharePage = max(1, (int)($_GET['share_page'] ?? 1));
    $shareSize = normalize_page_size($_GET['share_size'] ?? 10);
    if (!in_array($filterStatus, ['active', 'deleted', 'all'], true)) {
        $filterStatus = 'active';
    }
    $where = [];
    $params = [];
    if ($filterUser > 0) {
        $where[] = 'shares.user_id = :uid';
        $params[':uid'] = $filterUser;
    }
    if ($shareSearch !== '') {
        $where[] = '(shares.title LIKE :share_search OR shares.slug LIKE :share_search)';
        $params[':share_search'] = '%' . $shareSearch . '%';
    }
    if ($filterStatus === 'active') {
        $where[] = 'shares.deleted_at IS NULL';
    } elseif ($filterStatus === 'deleted') {
        $where[] = 'shares.deleted_at IS NOT NULL';
    }
    $shareSql = 'SELECT shares.*, users.username FROM shares JOIN users ON shares.user_id = users.id';
    $shareCountSql = 'SELECT COUNT(*) FROM shares JOIN users ON shares.user_id = users.id';
    if (!empty($where)) {
        $shareSql .= ' WHERE ' . implode(' AND ', $where);
        $shareCountSql .= ' WHERE ' . implode(' AND ', $where);
    }
    $shareCountStmt = $pdo->prepare($shareCountSql);
    $shareCountStmt->execute($params);
    $totalShares = (int)$shareCountStmt->fetchColumn();
    [$sharePage, $shareSize, $sharePages, $shareOffset] = paginate($totalShares, $sharePage, $shareSize);
    $shareSql .= ' ORDER BY shares.updated_at DESC LIMIT :limit OFFSET :offset';
    $stmt = $pdo->prepare($shareSql);
    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value);
    }
    $stmt->bindValue(':limit', $shareSize, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $shareOffset, PDO::PARAM_INT);
    $stmt->execute();
    $shares = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $reportStatus = (string)($_GET['report_status'] ?? 'pending');
    if (!in_array($reportStatus, ['pending', 'handled', 'all'], true)) {
        $reportStatus = 'pending';
    }
    $reportPage = max(1, (int)($_GET['report_page'] ?? 1));
    $reportSize = normalize_page_size($_GET['report_size'] ?? 10);
    $reportWhere = [];
    if ($reportStatus === 'pending') {
        $reportWhere[] = 'share_reports.handled_at IS NULL';
    } elseif ($reportStatus === 'handled') {
        $reportWhere[] = 'share_reports.handled_at IS NOT NULL';
    }
    $reportSql = 'SELECT share_reports.*, users.username AS share_username, reporters.username AS reporter_username
        FROM share_reports
        LEFT JOIN users ON share_reports.share_user_id = users.id
        LEFT JOIN users reporters ON share_reports.reporter_user_id = reporters.id';
    $reportCountSql = 'SELECT COUNT(*) FROM share_reports';
    if (!empty($reportWhere)) {
        $reportSql .= ' WHERE ' . implode(' AND ', $reportWhere);
        $reportCountSql .= ' WHERE ' . implode(' AND ', $reportWhere);
    }
    $reportCountStmt = $pdo->prepare($reportCountSql);
    $reportCountStmt->execute();
    $reportTotal = (int)$reportCountStmt->fetchColumn();
    [$reportPage, $reportSize, $reportPages, $reportOffset] = paginate($reportTotal, $reportPage, $reportSize);
    $reportSql .= ' ORDER BY share_reports.created_at DESC LIMIT :limit OFFSET :offset';
    $reportStmt = $pdo->prepare($reportSql);
    $reportStmt->bindValue(':limit', $reportSize, PDO::PARAM_INT);
    $reportStmt->bindValue(':offset', $reportOffset, PDO::PARAM_INT);
    $reportStmt->execute();
    $reports = $reportStmt->fetchAll(PDO::FETCH_ASSOC);

    $announcements = $pdo->query('SELECT a.*, u.username AS author FROM announcements a LEFT JOIN users u ON a.created_by = u.id ORDER BY a.created_at DESC')
        ->fetchAll(PDO::FETCH_ASSOC);
    $userQuery = $_GET;
    unset($userQuery['user_page'], $userQuery['user_size'], $userQuery['user_search'], $userQuery['user_status'], $userQuery['user_role']);
    $shareQuery = $_GET;
    unset($shareQuery['share_page'], $shareQuery['share_size'], $shareQuery['share_search'], $shareQuery['user'], $shareQuery['status']);
    $reportQuery = $_GET;
    unset($reportQuery['report_page'], $reportQuery['report_size'], $reportQuery['report_status']);
    $scanQuery = $_GET;
    unset($scanQuery['scan_page'], $scanQuery['scan_size']);
    if ($scanKeepParam !== null) {
        $scanQuery['scan_keep'] = $scanKeepParam;
    } else {
        unset($scanQuery['scan_keep']);
    }

    $content = '';
    if ($error) {
        $content .= '<div class="flash">' . htmlspecialchars($error) . '</div>';
    }
    if ($info) {
        $content .= '<div class="flash">' . htmlspecialchars($info) . '</div>';
    }

    $content .= '<div class="card" id="settings"><h2>站点设置</h2>';
    $content .= '<form method="post" action="' . base_path() . '/admin/settings">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<div class="grid">';
    $content .= '<div><label>默认存储上限 (MB)</label><input class="input" name="default_storage_limit_mb" type="number" min="0" value="' . (int)$defaultLimitMb . '"></div>';
    $content .= '<div><label>邮箱发件人</label><input class="input" name="email_from" value="' . htmlspecialchars((string)$emailFrom) . '"></div>';
    $content .= '<div><label>发件人名称</label><input class="input" name="email_from_name" value="' . htmlspecialchars((string)$emailFromName) . '"></div>';
    $content .= '<div><label>验证码主题</label><input class="input" name="email_subject" value="' . htmlspecialchars((string)$emailSubject) . '"></div>';
    $content .= '<div><label>重置密码主题</label><input class="input" name="email_reset_subject" value="' . htmlspecialchars((string)$emailResetSubject) . '"></div>';
    $content .= '<div><label>ICP备案号</label><input class="input" name="site_icp" value="' . htmlspecialchars((string)$siteIcp) . '"></div>';
    $content .= '<div><label>联系邮箱</label><input class="input" name="site_contact_email" value="' . htmlspecialchars((string)$siteContactEmail) . '"></div>';
    $content .= '<div><label>网站地址（分享链接前缀）<button class="link-button" type="button" data-report-open data-report-target="site-base-url-help">说明</button></label><input class="input" name="site_base_url" placeholder="https://share.example.com" value="' . htmlspecialchars((string)$siteBaseUrl) . '"></div>';
    $content .= '</div>';
    $content .= '<div style="margin-top:12px">';
    $content .= '<label>违禁词（用 | 分隔）</label>';
    $content .= '<textarea class="input" name="banned_words" rows="2" placeholder="示例：词1|词2|词3">' . htmlspecialchars($bannedWordsRaw) . '</textarea>';
    $content .= '<div class="muted">用户分享和分享页评论命中任意违禁词将拒绝分享和评论，并在扫描结果中标记。</div>';
    $content .= '</div>';
    $content .= '<div class="grid" style="margin-top:12px">';
    $content .= '<label><input type="checkbox" name="allow_registration" value="1"' . ($allowRegistration ? ' checked' : '') . '> 允许注册</label>';
    $content .= '<label><input type="checkbox" name="captcha_enabled" value="1"' . ($captchaEnabled ? ' checked' : '') . '> 启用验证码</label>';
    $content .= '<label><input type="checkbox" name="email_verification_enabled" value="1"' . ($emailVerifyEnabled ? ' checked' : '') . '> 启用邮箱验证码</label>';
    $content .= '<label><input type="checkbox" name="smtp_enabled" value="1"' . ($smtpEnabled ? ' checked' : '') . '> 启用 SMTP</label>';
    $content .= '</div>';
    $content .= '<div class="grid" style="margin-top:12px">';
    $content .= '<div><label>SMTP 主机</label><input class="input" name="smtp_host" value="' . htmlspecialchars((string)$smtpHost) . '"></div>';
    $content .= '<div><label>SMTP 端口</label><input class="input" name="smtp_port" type="number" min="0" value="' . htmlspecialchars((string)$smtpPort) . '"></div>';
    $content .= '<div><label>加密方式</label><select class="input" name="smtp_secure">';
    $content .= '<option value="none"' . ($smtpSecure === 'none' ? ' selected' : '') . '>无</option>';
    $content .= '<option value="tls"' . ($smtpSecure === 'tls' ? ' selected' : '') . '>TLS</option>';
    $content .= '<option value="ssl"' . ($smtpSecure === 'ssl' ? ' selected' : '') . '>SSL</option>';
    $content .= '</select></div>';
    $content .= '<div><label>SMTP 用户名</label><input class="input" name="smtp_user" value="' . htmlspecialchars((string)$smtpUser) . '"></div>';
    $content .= '<div><label>SMTP 密码</label><input class="input" type="password" name="smtp_pass" value="' . htmlspecialchars((string)$smtpPass) . '"></div>';
    $content .= '</div>';
    $content .= '<div style="margin-top:12px"><button class="button primary" type="submit">保存设置</button></div>';
    $content .= '</form></div>';
    $content .= '<div class="modal" id="site-base-url-help" data-report-modal hidden>';
    $content .= '<div class="modal-backdrop" data-modal-close></div>';
    $content .= '<div class="modal-card">';
    $content .= '<div class="modal-header">网站地址说明</div>';
    $content .= '<div class="modal-body">';
    $content .= '<p><strong>留空：</strong>自动识别当前访问地址（协议/域名/端口）。</p>';
    $content .= '<p><strong>填写：</strong>分享链接统一使用该前缀，适合反代/HTTPS 终止/端口丢失等场景。</p>';
    $content .= '<p><strong>示例：</strong><code>https://share.example.com</code> 或 <code>https://IP:端口</code></p>';
    $content .= '<p><strong>说明：</strong>仅影响分享链接前缀，不会限制其他访问方式。</p>';
    $content .= '</div>';
    $content .= '<div class="modal-actions"><button class="button" type="button" data-modal-close>关闭</button></div>';
    $content .= '</div>';
    $content .= '</div>';

    $content .= '<div class="card"><h2>SMTP 测试</h2>';
    $content .= '<form method="post" action="' . base_path() . '/admin/smtp-test">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<div class="grid">';
    $content .= '<div><label>测试邮箱</label><input class="input" name="test_email" placeholder="例如 test@example.com" required></div>';
    $content .= '</div>';
    $content .= '<div style="margin-top:12px"><button class="button" type="submit">发送测试邮件</button></div>';
    $content .= '</form></div>';

    $content .= '<div class="card" id="announcements"><h2>发布公告</h2>';
    $content .= '<form method="post" action="' . base_path() . '/admin/announcement/create">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<div class="grid">';
    $content .= '<div><label>标题</label><input class="input" name="title" required></div>';
    $content .= '<div><label>内容</label><textarea class="input" name="content" rows="4" required></textarea></div>';
    $content .= '</div>';
    $content .= '<div class="muted" style="margin-top:6px">支持 HTML，保存后将直接渲染。</div>';
    $content .= '<div style="margin-top:12px">';
    $content .= '<label><input type="checkbox" name="active" value="1" checked> 立即发布</label>';
    $content .= '</div>';
    $content .= '<div style="margin-top:12px"><button class="button primary" type="submit">发布公告</button></div>';
    $content .= '</form></div>';

    $content .= '<div class="card"><h2>公告列表</h2>';
    if (empty($announcements)) {
        $content .= '<p class="muted">暂无公告。</p>';
    } else {
        $content .= '<table class="table"><thead><tr><th>标题</th><th>状态</th><th>发布人</th><th>发布时间</th><th>操作</th></tr></thead><tbody>';
        foreach ($announcements as $item) {
            $status = ((int)$item['active'] === 1) ? '已启用' : '已停用';
            $author = $item['author'] ?? '系统';
            $content .= '<tr>';
            $content .= '<td>' . htmlspecialchars($item['title']) . '</td>';
            $content .= '<td>' . htmlspecialchars($status) . '</td>';
            $content .= '<td>' . htmlspecialchars($author) . '</td>';
            $content .= '<td>' . htmlspecialchars($item['created_at']) . '</td>';
            $content .= '<td class="actions">';
            $content .= '<form method="post" action="' . base_path() . '/admin/announcement/toggle" class="inline-form">';
            $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
            $content .= '<input type="hidden" name="announcement_id" value="' . (int)$item['id'] . '">';
            $content .= '<button class="button" type="submit">' . (((int)$item['active'] === 1) ? '停用' : '启用') . '</button>';
            $content .= '</form>';
            $content .= '<form method="post" action="' . base_path() . '/admin/announcement/delete" class="inline-form">';
            $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
            $content .= '<input type="hidden" name="announcement_id" value="' . (int)$item['id'] . '">';
            $content .= '<button class="button danger" type="submit">删除</button>';
            $content .= '</form>';
            $content .= '<details class="announcement-edit">';
            $content .= '<summary class="button">编辑</summary>';
            $content .= '<form method="post" action="' . base_path() . '/admin/announcement/update" class="announcement-edit-form">';
            $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
            $content .= '<input type="hidden" name="announcement_id" value="' . (int)$item['id'] . '">';
            $content .= '<div class="grid">';
            $content .= '<div><label>标题</label><input class="input" name="title" value="' . htmlspecialchars($item['title']) . '" required></div>';
            $content .= '<div><label>内容</label><textarea class="input" name="content" rows="4" required>' . htmlspecialchars((string)$item['content']) . '</textarea></div>';
            $content .= '</div>';
            $content .= '<div class="muted" style="margin-top:6px">支持 HTML，保存后将直接渲染。</div>';
            $content .= '<label style="margin-top:8px"><input type="checkbox" name="active" value="1"' . (((int)$item['active'] === 1) ? ' checked' : '') . '> 启用</label>';
            $content .= '<div style="margin-top:8px"><button class="button primary" type="submit">保存修改</button></div>';
            $content .= '</form>';
            $content .= '</details>';
            $content .= '</td>';
            $content .= '</tr>';
        }
        $content .= '</tbody></table>';
    }
    $content .= '</div>';

    $content .= '<div class="card" id="reports"><h2>举报管理</h2>';
    $content .= '<form method="get" action="' . base_path() . '/admin#reports" class="filter-form">';
    $content .= render_hidden_inputs($reportQuery);
    $content .= '<div class="grid">';
    $content .= '<div><label>状态筛选</label><select class="input" name="report_status">';
    $content .= '<option value="pending"' . ($reportStatus === 'pending' ? ' selected' : '') . '>未处理</option>';
    $content .= '<option value="handled"' . ($reportStatus === 'handled' ? ' selected' : '') . '>已处理</option>';
    $content .= '<option value="all"' . ($reportStatus === 'all' ? ' selected' : '') . '>全部</option>';
    $content .= '</select></div>';
    $content .= '</div>';
    $content .= '<div style="margin-top:12px"><button class="button" type="submit">筛选</button></div>';
    $content .= '</form>';
    $content .= '<form id="report-batch-form" method="post" action="' . base_path() . '/admin/report-batch" data-confirm-message="确定删除选中的举报记录吗？">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<div class="table-actions">';
    $content .= '<label class="checkbox"><input type="checkbox" data-check-all="reports" form="report-batch-form"> 全选</label>';
    $content .= '<select class="input" name="action">';
    $content .= '<option value="delete">批量删除</option>';
    $content .= '</select>';
    $content .= '<button class="button" type="submit">执行</button>';
    $content .= '</div>';
    $content .= '</form>';
    if (empty($reports)) {
        $content .= '<p class="muted" style="margin-top:12px">暂无举报记录。</p>';
    } else {
        $content .= '<table class="table" style="margin-top:12px"><thead><tr><th><input type="checkbox" data-check-all="reports" form="report-batch-form"></th><th>时间</th><th>分享</th><th>用户</th><th>状态</th><th>操作</th></tr></thead><tbody>';
        foreach ($reports as $report) {
            $reportId = (int)($report['id'] ?? 0);
            $shareTitle = htmlspecialchars((string)($report['share_title'] ?? ''));
            $shareSlug = (string)($report['share_slug'] ?? '');
            $shareUrl = $shareSlug !== '' ? share_url($shareSlug) : '';
            $shareUserId = (int)($report['share_user_id'] ?? 0);
            $shareUser = htmlspecialchars((string)($report['share_username'] ?? ''));
            $reporter = (string)($report['reporter_username'] ?? '');
            $reporterLabel = $reporter !== '' ? htmlspecialchars($reporter) : '游客';
            $reportEmailRaw = (string)($report['report_email'] ?? '');
            $reportEmailLabel = $reportEmailRaw !== '' ? $reportEmailRaw : '-';
            $reason = report_reason_label((string)($report['reason_type'] ?? ''));
            $detailRaw = (string)($report['reason_detail'] ?? '');
            $created = htmlspecialchars((string)($report['created_at'] ?? ''));
            $handledAt = (string)($report['handled_at'] ?? '');
            $statusLabel = $handledAt !== '' ? '已处理' : '未处理';
            $modalId = 'report-view-' . $reportId;
            $content .= '<tr>';
            $content .= '<td><input type="checkbox" name="report_ids[]" value="' . $reportId . '" data-check-item="reports" form="report-batch-form"></td>';
            $content .= '<td>' . $created . '</td>';
            $content .= '<td>';
            if ($shareUrl !== '') {
                $content .= '<a href="' . htmlspecialchars($shareUrl) . '" target="_blank">' . $shareTitle . '</a>';
                $content .= '<div class="muted">/s/' . htmlspecialchars($shareSlug) . '</div>';
            } else {
                $content .= $shareTitle !== '' ? $shareTitle : '已删除';
            }
            $content .= '</td>';
            $content .= '<td>';
            if ($shareUserId > 0) {
                $content .= '<a href="' . base_path() . '/admin?user=' . $shareUserId . '&status=all#shares">' . ($shareUser !== '' ? $shareUser : ('ID:' . $shareUserId)) . '</a>';
            } else {
                $content .= $shareUser !== '' ? $shareUser : '-';
            }
            $content .= '</td>';
            $content .= '<td>' . htmlspecialchars($statusLabel) . '</td>';
            $content .= '<td class="actions">';
            $content .= '<button class="button ghost" type="button" data-report-open data-report-target="' . htmlspecialchars($modalId) . '">查看举报内容</button>';
            if ($handledAt === '') {
                $content .= '<form method="post" action="' . base_path() . '/admin/report-handle" class="inline-form">';
                $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
                $content .= '<input type="hidden" name="report_id" value="' . $reportId . '">';
                $content .= '<button class="button" type="submit">标记已处理</button>';
                $content .= '</form>';
            }
            if ($handledAt !== '') {
                $content .= '<form method="post" action="' . base_path() . '/admin/report-delete" class="inline-form" data-confirm-message="确定删除该举报记录吗？">';
                $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
                $content .= '<input type="hidden" name="report_id" value="' . $reportId . '">';
                $content .= '<button class="button ghost" type="submit">删除记录</button>';
                $content .= '</form>';
            }
            if ($shareSlug !== '') {
                $content .= '<form method="post" action="' . base_path() . '/admin/report-share-delete" class="inline-form" data-confirm-message="确定彻底删除该分享吗？该操作不可恢复。">';
                $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
                $content .= '<input type="hidden" name="report_id" value="' . $reportId . '">';
                $content .= '<button class="button danger" type="submit">彻底删除分享</button>';
                $content .= '</form>';
            }
            if ($shareUserId > 0) {
                $content .= '<form method="post" action="' . base_path() . '/admin/report-user-disable" class="inline-form" data-confirm-message="确定禁用该账号吗？">';
                $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
                $content .= '<input type="hidden" name="report_id" value="' . $reportId . '">';
                $content .= '<button class="button" type="submit">禁用账号</button>';
                $content .= '</form>';
            }
            $content .= '<div class="modal report-modal" id="' . htmlspecialchars($modalId) . '" data-report-modal hidden>';
            $content .= '<div class="modal-backdrop" data-modal-close></div>';
            $content .= '<div class="modal-card">';
            $content .= '<div class="modal-header"><h3>举报内容</h3></div>';
            $content .= '<div class="modal-body">';
            $content .= '<div class="report-grid">';
            $content .= '<div><label>举报类型</label><input class="input" value="' . htmlspecialchars($reason) . '" readonly></div>';
            $content .= '<div><label>举报邮箱</label><input class="input" value="' . htmlspecialchars($reportEmailLabel) . '" readonly></div>';
            $content .= '<div><label>举报者</label><input class="input" value="' . htmlspecialchars($reporterLabel) . '" readonly></div>';
            $content .= '<div class="report-wide"><label>补充说明</label><textarea class="input" rows="4" readonly>' . htmlspecialchars($detailRaw) . '</textarea></div>';
            $content .= '</div>';
            $content .= '<div class="modal-actions"><button class="button" type="button" data-modal-close>关闭</button></div>';
            $content .= '</div>';
            $content .= '</div>';
            $content .= '</div>';
            $content .= '</td>';
            $content .= '</tr>';
        }
        $content .= '</tbody></table>';
    }
    $content .= '<div class="pagination">';
    $content .= '<a class="button ghost" href="' . build_admin_query_url('reports', ['report_page' => max(1, $reportPage - 1)]) . '">上一页</a>';
    $content .= '<div class="pagination-info">第' . $reportPage . ' / ' . $reportPages . ' 页，共 ' . $reportTotal . ' 条举报</div>';
    $content .= '<a class="button ghost" href="' . build_admin_query_url('reports', ['report_page' => min($reportPages, $reportPage + 1)]) . '">下一页</a>';
    $content .= '<form method="get" action="' . base_path() . '/admin#reports" class="pagination-form">';
    $content .= render_hidden_inputs(array_merge($reportQuery, [
        'report_status' => $reportStatus,
    ]));
    $content .= '<label>每页</label><select class="input" name="report_size">';
    foreach ([10, 50, 200, 1000] as $size) {
        $selected = $reportSize === $size ? ' selected' : '';
        $content .= '<option value="' . $size . '"' . $selected . '>' . $size . '</option>';
    }
    $content .= '</select>';
    $content .= '<label>页码</label><input class="input small" type="number" name="report_page" min="1" max="' . $reportPages . '" value="' . $reportPage . '">';
    $content .= '<button class="button" type="submit">跳转</button>';
    $content .= '</form>';
    $content .= '</div>';
    $content .= '</div>';

    $content .= '<div class="card" id="users"><h2>用户管理</h2>';
    $content .= '<form method="get" action="' . base_path() . '/admin#users" class="filter-form">';
    $content .= render_hidden_inputs($userQuery);
    $content .= '<div class="grid">';
    $content .= '<div><label>关键词</label><input class="input" name="user_search" placeholder="用户名 / 邮箱" value="' . htmlspecialchars($userSearch) . '"></div>';
    $content .= '<div><label>状态筛选</label><select class="input" name="user_status">';
    $content .= '<option value="all"' . ($userStatus === 'all' ? ' selected' : '') . '>全部</option>';
    $content .= '<option value="active"' . ($userStatus === 'active' ? ' selected' : '') . '>正常</option>';
    $content .= '<option value="disabled"' . ($userStatus === 'disabled' ? ' selected' : '') . '>已禁用</option>';
    $content .= '</select></div>';
    $content .= '<div><label>角色筛选</label><select class="input" name="user_role">';
    $content .= '<option value="all"' . ($userRole === 'all' ? ' selected' : '') . '>全部</option>';
    $content .= '<option value="admin"' . ($userRole === 'admin' ? ' selected' : '') . '>管理员</option>';
    $content .= '<option value="user"' . ($userRole === 'user' ? ' selected' : '') . '>普通用户</option>';
    $content .= '</select></div>';
    $content .= '</div>';
    $content .= '<div class="table-actions">';
    $content .= '<button class="button" type="submit">筛选</button>';
    $content .= '<button class="button" type="button" data-user-create-open>添加账号</button>';
    $content .= '</div>';
    $content .= '</form>';

    $content .= '<form id="user-batch-form" method="post" action="' . base_path() . '/admin/user-batch" data-batch-form="user">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<div class="table-actions">';
    $content .= '<label class="checkbox"><input type="checkbox" data-check-all="users" form="user-batch-form"> 全选</label>';
    $content .= '<select class="input" name="action">';
    $content .= '<option value="disable">批量禁用</option>';
    $content .= '<option value="enable">批量启用</option>';
    $content .= '<option value="delete">批量删除</option>';
    $content .= '</select>';
    $content .= '<button class="button" type="submit">执行</button>';
    $content .= '</div>';
    $content .= '</form>';
    if (empty($users)) {
        $content .= '<p class="muted" style="margin-top:12px">暂无用户记录。</p>';
    } else {
        $content .= '<table class="table"><thead><tr><th><input type="checkbox" data-check-all="users" form="user-batch-form"></th><th>用户名</th><th>角色</th><th>状态</th><th>邮箱</th><th>存储</th><th>操作</th></tr></thead><tbody>';
        foreach ($users as $u) {
            $status = (int)$u['disabled'] === 1 ? '禁用' : '正常';
            $roleLabel = $u['role'] === 'admin' ? '管理员' : '用户';
            $limitMb = mb_from_bytes((int)$u['storage_limit_bytes']);
            $limitLabel = (int)$u['storage_limit_bytes'] > 0
                ? format_bytes((int)$u['storage_limit_bytes'])
                : ($defaultLimitBytes > 0 ? '默认(' . format_bytes($defaultLimitBytes) . ')' : '不限');
            $usedLabel = format_bytes((int)$u['storage_used_bytes']);
            $disabledAttr = $u['role'] === 'admin' ? ' disabled' : '';
            $content .= '<tr>';
            $content .= '<td><input type="checkbox" name="user_ids[]" value="' . (int)$u['id'] . '" data-check-item="users" form="user-batch-form"' . $disabledAttr . '></td>';
            $content .= '<td>' . htmlspecialchars($u['username']) . '</td>';
            $content .= '<td>' . htmlspecialchars($roleLabel) . '</td>';
            $content .= '<td>' . htmlspecialchars($status) . '</td>';
            $content .= '<td>' . htmlspecialchars((string)$u['email']) . '</td>';
            $content .= '<td>' . htmlspecialchars($usedLabel) . ' / ' . htmlspecialchars($limitLabel) . '</td>';
            $content .= '<td class="actions">';
            $content .= '<button class="button" type="button" data-user-edit data-user-id="' . (int)$u['id'] . '" data-user-name="' . htmlspecialchars($u['username']) . '" data-user-email="' . htmlspecialchars((string)$u['email']) . '" data-user-role="' . htmlspecialchars((string)$u['role']) . '" data-user-disabled="' . (int)$u['disabled'] . '" data-user-limit="' . (int)$limitMb . '">编辑</button>';
            $shareUrl = build_admin_query_url('shares', ['user' => (int)$u['id'], 'status' => 'all']);
            $content .= '<a class="button" href="' . htmlspecialchars($shareUrl) . '">查看分享</a>';
            if ($u['role'] !== 'admin' && (int)$u['id'] !== (int)$admin['id']) {
                $content .= '<form method="post" action="' . base_path() . '/admin/user-delete" class="inline-form" data-confirm-message="确定删除该用户及其所有分享吗？该操作不可恢复。">';
                $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
                $content .= '<input type="hidden" name="user_id" value="' . (int)$u['id'] . '">';
                $content .= '<button class="button danger" type="submit">删除</button>';
                $content .= '</form>';
            }
            $content .= '</td>';
            $content .= '</tr>';
        }
        $content .= '</tbody></table>';
    }
    $content .= '';

    $content .= '<div class="pagination">';
    $content .= '<a class="button ghost" href="' . build_admin_query_url('users', ['user_page' => max(1, $userPage - 1)]) . '">上一页</a>';
    $content .= '<div class="pagination-info">第 ' . $userPage . ' / ' . $userPages . ' 页，共 ' . $totalUsers . ' 个用户</div>';
    $content .= '<a class="button ghost" href="' . build_admin_query_url('users', ['user_page' => min($userPages, $userPage + 1)]) . '">下一页</a>';
    $content .= '<form method="get" action="' . base_path() . '/admin#users" class="pagination-form">';
    $content .= render_hidden_inputs(array_merge($userQuery, [
        'user_search' => $userSearch,
        'user_status' => $userStatus,
        'user_role' => $userRole,
    ]));
    $content .= '<label>每页</label><select class="input" name="user_size">';
    foreach ([10, 50, 200, 1000] as $size) {
        $selected = $userSize === $size ? ' selected' : '';
        $content .= '<option value="' . $size . '"' . $selected . '>' . $size . '</option>';
    }
    $content .= '</select>';
    $content .= '<label>页码</label><input class="input small" type="number" name="user_page" min="1" max="' . $userPages . '" value="' . $userPage . '">';
    $content .= '<button class="button" type="submit">跳转</button>';
    $content .= '</form>';
    $content .= '</div>';
    $content .= '</div>';

    $content .= '<div class="card" id="shares"><h2>分享管理</h2>';
    $content .= '<form method="get" action="' . base_path() . '/admin#shares" class="filter-form">';
    $content .= render_hidden_inputs($shareQuery);
    $content .= '<div class="grid">';
    $content .= '<div><label>关键词</label><input class="input" name="share_search" placeholder="标题 / Slug" value="' . htmlspecialchars($shareSearch) . '"></div>';
    $content .= '<div><label>用户筛选</label><select class="input" name="user">';
    $content .= '<option value="0">全部用户</option>';
    foreach ($allUsers as $u) {
        $selected = ($filterUser === (int)$u['id']) ? ' selected' : '';
        $content .= '<option value="' . (int)$u['id'] . '"' . $selected . '>' . htmlspecialchars($u['username']) . '</option>';
    }
    $content .= '</select></div>';
    $content .= '<div><label>状态筛选</label><select class="input" name="status">';
    $content .= '<option value="all"' . ($filterStatus === 'all' ? ' selected' : '') . '>全部</option>';
    $content .= '<option value="active"' . ($filterStatus === 'active' ? ' selected' : '') . '>正常</option>';
    $content .= '<option value="deleted"' . ($filterStatus === 'deleted' ? ' selected' : '') . '>已删除</option>';
    $content .= '</select></div>';
    $content .= '</div>';
    $content .= '<div style="margin-top:12px"><button class="button" type="submit">筛选</button></div>';
    $content .= '</form>';

    $content .= '<form id="share-batch-form" method="post" action="' . base_path() . '/admin/share-batch" data-batch-form="share">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<div class="table-actions">';
    $content .= '<label class="checkbox"><input type="checkbox" data-check-all="shares" form="share-batch-form"> 全选</label>';
    $content .= '<select class="input" name="action">';
    $content .= '<option value="soft_delete">批量软删除</option>';
    $content .= '<option value="restore">批量恢复</option>';
    $content .= '<option value="hard_delete">批量彻底删除</option>';
    $content .= '</select>';
    $content .= '<button class="button" type="submit" data-confirm="hard_delete">执行</button>';
    $content .= '</div>';
    $content .= '</form>';
    if (empty($shares)) {
        $content .= '<p class="muted" style="margin-top:12px">暂无分享记录。</p>';
    } else {
        $content .= '<table class="table" style="margin-top:12px"><thead><tr><th><input type="checkbox" data-check-all="shares" form="share-batch-form"></th><th>标题</th><th>链接</th><th>类型</th><th>用户</th><th>密码</th><th>到期</th><th>访客上限</th><th>状态</th><th>评论邮件通知</th><th>大小</th><th>更新时间</th><th>操作</th></tr></thead><tbody>';
        foreach ($shares as $share) {
            $type = $share['type'] === 'notebook' ? '笔记本' : '文档';
            $status = $share['deleted_at'] ? '已删除' : '正常';
            $size = format_bytes((int)($share['size_bytes'] ?? 0));
            $url = share_url((string)$share['slug']);
            $hasPassword = !empty($share['password_hash']) ? '有密码' : '无密码';
            $expiresAt = !empty($share['expires_at']) ? date('Y-m-d H:i', (int)$share['expires_at']) : '永久';
            $visitorLimit = (int)($share['visitor_limit'] ?? 0);
            if ($visitorLimit > 0) {
                $visitorCount = share_visitor_count((int)$share['id']);
                $visitorLabel = $visitorCount . '/' . $visitorLimit;
            } else {
                $visitorLabel = '不限';
            }
            $content .= '<tr>';
            $content .= '<td><input type="checkbox" name="share_ids[]" value="' . (int)$share['id'] . '" data-check-item="shares" form="share-batch-form"></td>';
            $content .= '<td>' . htmlspecialchars($share['title']) . '</td>';
            $content .= '<td><a href="' . htmlspecialchars($url) . '" target="_blank">' . htmlspecialchars($url) . '</a></td>';
            $content .= '<td>' . htmlspecialchars($type) . '</td>';
            $content .= '<td>' . htmlspecialchars($share['username'] ?? '') . '</td>';
            $content .= '<td>' . htmlspecialchars($hasPassword) . '</td>';
            $content .= '<td>' . htmlspecialchars($expiresAt) . '</td>';
            $content .= '<td>' . htmlspecialchars($visitorLabel) . '</td>';
            $content .= '<td>' . htmlspecialchars($status) . '</td>';
            $content .= '<td>' . (((int)($share['comment_notify'] ?? 0) === 1) ? '开启' : '关闭') . '</td>';
            $content .= '<td>' . htmlspecialchars($size) . '</td>';
            $content .= '<td>' . htmlspecialchars($share['updated_at']) . '</td>';
            $content .= '<td class="actions">';
            if ($share['deleted_at']) {
                $content .= '<form method="post" action="' . base_path() . '/admin/share-restore" class="inline-form">';
                $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
                $content .= '<input type="hidden" name="share_id" value="' . (int)$share['id'] . '">';
                $content .= '<button class="button" type="submit">恢复</button>';
                $content .= '</form>';
            } else {
                $content .= '<form method="post" action="' . base_path() . '/admin/share-delete" class="inline-form">';
                $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
                $content .= '<input type="hidden" name="share_id" value="' . (int)$share['id'] . '">';
                $content .= '<button class="button" type="submit">软删除</button>';
                $content .= '</form>';
            }
            $content .= '<form method="post" action="' . base_path() . '/admin/share-hard-delete" class="inline-form">';
            $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
            $content .= '<input type="hidden" name="share_id" value="' . (int)$share['id'] . '">';
            $content .= '<button class="button danger" type="submit">彻底删除</button>';
            $content .= '</form>';
            $content .= '</td>';
            $content .= '</tr>';
        }
        $content .= '</tbody></table>';
    }
    $content .= '';

    $content .= '<div class="pagination">';
    $content .= '<a class="button ghost" href="' . build_admin_query_url('shares', ['share_page' => max(1, $sharePage - 1)]) . '">上一页</a>';
    $content .= '<div class="pagination-info">第 ' . $sharePage . ' / ' . $sharePages . ' 页，共 ' . $totalShares . ' 条分享</div>';
    $content .= '<a class="button ghost" href="' . build_admin_query_url('shares', ['share_page' => min($sharePages, $sharePage + 1)]) . '">下一页</a>';
    $content .= '<form method="get" action="' . base_path() . '/admin#shares" class="pagination-form">';
    $content .= render_hidden_inputs(array_merge($shareQuery, [
        'share_search' => $shareSearch,
        'user' => $filterUser,
        'status' => $filterStatus,
    ]));
    $content .= '<label>每页</label><select class="input" name="share_size">';
    foreach ([10, 50, 200, 1000] as $size) {
        $selected = $shareSize === $size ? ' selected' : '';
        $content .= '<option value="' . $size . '"' . $selected . '>' . $size . '</option>';
    }
    $content .= '</select>';
    $content .= '<label>页码</label><input class="input small" type="number" name="share_page" min="1" max="' . $sharePages . '" value="' . $sharePage . '">';
    $content .= '<button class="button" type="submit">跳转</button>';
    $content .= '</form>';
    $content .= '</div>';
    $content .= '</div>';

    $chunkTtlHours = $chunkTtlSeconds > 0 ? ($chunkTtlSeconds / 3600) : 2;
    $content .= '<div class="card" id="chunks"><h2>分片清理</h2>';
    $content .= '<div class="muted">仅显示超过 ' . htmlspecialchars(number_format($chunkTtlHours, 1)) . ' 小时未更新的分片目录。</div>';
    if (empty($staleChunks)) {
        $content .= '<p class="muted" style="margin-top:12px">暂无过期分片。</p>';
    } else {
        $content .= '<form method="post" action="' . base_path() . '/admin/chunk-clean" class="inline-form" style="margin-top:12px">';
        $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
        $content .= '<button class="button danger" type="submit">清理全部过期分片</button>';
        $content .= '</form>';
        $content .= '<table class="table" style="margin-top:12px"><thead><tr><th>目录</th><th>最后更新</th><th>已过期</th><th>操作</th></tr></thead><tbody>';
        foreach ($staleChunks as $chunk) {
            $chunkId = (string)$chunk['id'];
            $mtime = (int)$chunk['mtime'];
            $ageHours = max(0, $chunk['age'] / 3600);
            $content .= '<tr>';
            $content .= '<td><span class="muted">' . htmlspecialchars($chunkId) . '</span></td>';
            $content .= '<td>' . htmlspecialchars(date('Y-m-d H:i', $mtime)) . '</td>';
            $content .= '<td>' . htmlspecialchars(number_format($ageHours, 1)) . ' 小时</td>';
            $content .= '<td class="actions">';
            $content .= '<form method="post" action="' . base_path() . '/admin/chunk-delete" class="inline-form">';
            $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
            $content .= '<input type="hidden" name="chunk_id" value="' . htmlspecialchars($chunkId) . '">';
            $content .= '<button class="button danger" type="submit">删除</button>';
            $content .= '</form>';
            $content .= '</td>';
            $content .= '</tr>';
        }
        $content .= '</tbody></table>';
    }
    $content .= '</div>';

    $content .= '<div class="card" id="scan"><h2>违禁词扫描</h2>';
    if ($bannedWordsRaw === '') {
        $content .= '<div class="notice">请先在“站点设置”里配置违禁词。</div>';
    }
    $content .= '<form method="post" action="' . base_path() . '/admin/scan" data-scan-form="1">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<button class="button" type="submit">开始扫描</button>';
    $content .= '</form>';
    $content .= '<div class="scan-progress" data-scan-progress' . $scanProgressHidden . '>';
    $content .= '<div class="scan-progress__bar"><span data-scan-bar' . $scanBarStyle . '></span></div>';
    $content .= '<div class="scan-progress__status" data-scan-status>' . htmlspecialchars($scanStatusLabel) . '</div>';
    $content .= '<div class="scan-log" data-scan-log>' . $scanLogHtml . '</div>';
    $content .= '</div>';
    if (!empty($scanResults)) {
        $shareIds = [];
        $userIds = [];
        foreach ($scanResults as $hit) {
            if (!isset($hit['share_id'], $hit['user_id'])) {
                continue;
            }
            $shareIds[(int)$hit['share_id']] = true;
            $userIds[(int)$hit['user_id']] = true;
        }
        $scanTimeLabel = $scanAt ? date('Y-m-d H:i', $scanAt) : '未知';
        $content .= '<div class="muted" style="margin-top:10px">最近扫描：' . htmlspecialchars($scanTimeLabel) . '，命中 ' . count($scanResults) . ' 条记录，涉及 ' . count($shareIds) . ' 个分享 / ' . count($userIds) . ' 个账号。</div>';
        $content .= '<div class="scan-actions" style="margin-top:10px">';
        $content .= '<form method="post" action="' . base_path() . '/admin/scan/delete" class="inline-form">';
        $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
        $content .= '<button class="button danger" type="submit">一键删除违规分享</button>';
        $content .= '</form>';
        $content .= '<form method="post" action="' . base_path() . '/admin/scan/disable" class="inline-form">';
        $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
        $content .= '<button class="button" type="submit">一键停用违规账号</button>';
        $content .= '</form>';
        $content .= '</div>';

        $content .= '<form id="scan-batch-form" method="post" action="' . base_path() . '/admin/scan/batch">';
        $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
        $content .= '<div class="table-actions">';
        $content .= '<label class="checkbox"><input type="checkbox" data-check-all="scan" form="scan-batch-form"> 全选</label>';
        $content .= '<select class="input" name="action">';
        $content .= '<option value="delete">批量删除分享</option>';
        $content .= '<option value="disable">批量停用账号</option>';
        $content .= '</select>';
        $content .= '<button class="button" type="submit">执行</button>';
        $content .= '</div>';
        $content .= '</form>';
        $content .= '<table class="table scan-table" style="margin-top:12px"><thead><tr><th><input type="checkbox" data-check-all="scan" form="scan-batch-form"></th><th>分享</th><th>文档/评论</th><th>用户</th><th>违禁词</th><th>预览</th><th>链接</th></tr></thead><tbody>';
        foreach ($scanPageResults as $hit) {
            $itemType = (string)($hit['item_type'] ?? 'doc');
            $shareTitleRaw = (string)($hit['share_title'] ?? '');
            $shareTitle = htmlspecialchars($shareTitleRaw);
            $docTitleRaw = (string)($hit['doc_title'] ?? $hit['doc_id'] ?? '');
            $docTitle = htmlspecialchars($docTitleRaw);
            $hPath = trim((string)($hit['hpath'] ?? ''), '/');
            $userName = htmlspecialchars((string)($hit['username'] ?? ''));
            $word = htmlspecialchars((string)($hit['word'] ?? ''));
            $snippet = htmlspecialchars((string)($hit['snippet'] ?? ''));
            $shareUrl = $hit['slug'] ? share_url((string)$hit['slug']) : '';
            $commentId = (int)($hit['comment_id'] ?? 0);
            $commentEmail = trim((string)($hit['comment_email'] ?? ''));
            $commentCreatedAt = (string)($hit['comment_created_at'] ?? '');
            $commentContent = (string)($hit['comment_content'] ?? '');
            $value = (int)($hit['share_id'] ?? 0) . '|' . (int)($hit['user_id'] ?? 0);
            $slug = (string)($hit['slug'] ?? '');
            $detailTitleHtml = htmlspecialchars($docTitleRaw);
            $detailMeta = $hPath;
            $docId = (string)($hit['doc_id'] ?? '');
            if ($itemType === 'doc') {
                $docLabel = trim($docTitleRaw) !== '' ? $docTitleRaw : $docId;
                $docLabel = $docLabel !== '' ? '文档：' . $docLabel : '文档';
                $detailTitleHtml = htmlspecialchars($docLabel);
                $detailMeta = $hPath !== '' ? '路径：' . $hPath : '';
                $docUrl = $shareUrl;
                if ($slug !== '' && $docId !== '') {
                    $docUrl = base_url() . build_share_redirect_path($slug, $docId, '');
                }
                if ($docUrl !== '') {
                    $detailTitleHtml = '<a class="scan-comment-link" href="' . htmlspecialchars($docUrl) . '" target="_blank">' . htmlspecialchars($docLabel) . '</a>';
                    $shareUrl = $docUrl;
                }
            }
            if ($itemType === 'comment') {
                $metaParts = [];
                if ($commentEmail !== '') {
                    $metaParts[] = '邮箱：' . $commentEmail;
                }
                if ($commentCreatedAt !== '') {
                    $metaParts[] = '时间：' . format_share_datetime($commentCreatedAt);
                }
                $detailMeta = implode(' / ', $metaParts);
                if ($shareUrl !== '' && $commentId > 0) {
                    $shareUrl .= '#comment-' . $commentId;
                }
                if ($commentId > 0) {
                    $detailTitleHtml = '<button type="button" class="scan-comment-link" data-admin-comment-edit="1"'
                        . ' data-admin-comment-id="' . $commentId . '"'
                        . ' data-admin-comment-email="' . htmlspecialchars($commentEmail, ENT_QUOTES) . '"'
                        . ' data-admin-comment-created="' . htmlspecialchars(format_share_datetime($commentCreatedAt), ENT_QUOTES) . '"'
                        . ' data-admin-comment-share="' . htmlspecialchars($shareTitleRaw, ENT_QUOTES) . '"'
                        . ' data-admin-comment-content="' . htmlspecialchars($commentContent, ENT_QUOTES) . '"'
                        . '>评论#' . $commentId . '</button>';
                } else {
                    $detailTitleHtml = '评论';
                }
            }
            $content .= '<tr>';
            $content .= '<td><input type="checkbox" name="scan_ids[]" value="' . htmlspecialchars($value) . '" data-check-item="scan" form="scan-batch-form"></td>';
            $content .= '<td>' . $shareTitle . '</td>';
            $content .= '<td>' . $detailTitleHtml;
            if ($detailMeta !== '') {
                $content .= '<div class="muted">' . htmlspecialchars($detailMeta) . '</div>';
            }
            $content .= '</td>';
            $content .= '<td>' . $userName . '</td>';
            $content .= '<td>' . $word . '</td>';
            $content .= '<td><div class="scan-snippet">' . $snippet . '</div></td>';
            $content .= '<td>';
            if ($shareUrl !== '') {
                $content .= '<a href="' . htmlspecialchars($shareUrl) . '" target="_blank">打开</a>';
            } else {
                $content .= '-';
            }
            $content .= '</td>';
            $content .= '</tr>';
        }
        $content .= '</tbody></table>';

        $content .= '<div class="pagination">';
        $content .= '<a class="button ghost" href="' . build_admin_query_url('scan', ['scan_page' => max(1, $scanPage - 1), 'scan_keep' => $scanKeepParam]) . '">上一页</a>';
        $content .= '<div class="pagination-info">第 ' . $scanPage . ' / ' . $scanPages . ' 页，共 ' . $scanTotal . ' 条记录</div>';
        $content .= '<a class="button ghost" href="' . build_admin_query_url('scan', ['scan_page' => min($scanPages, $scanPage + 1), 'scan_keep' => $scanKeepParam]) . '">下一页</a>';
        $content .= '<form method="get" action="' . base_path() . '/admin#scan" class="pagination-form">';
        $content .= render_hidden_inputs($scanQuery);
        $content .= '<label>每页</label><select class="input" name="scan_size">';
        foreach ([10, 50, 200, 1000] as $size) {
            $selected = $scanSize === $size ? ' selected' : '';
            $content .= '<option value="' . $size . '"' . $selected . '>' . $size . '</option>';
        }
        $content .= '</select>';
        $content .= '<label>页码</label><input class="input small" type="number" name="scan_page" min="1" max="' . $scanPages . '" value="' . $scanPage . '">';
        $content .= '<button class="button" type="submit">跳转</button>';
        $content .= '</form>';
        $content .= '</div>';
    } else {
        $content .= '<p class="muted" style="margin-top:12px">暂无扫描结果。</p>';
    }
    $content .= '</div>';

    $content .= '<div class="card danger-zone"><h2>危险操作</h2>';
    $content .= '<p class="muted">删除所有数据将清空用户、分享与公告，仅保留初始管理员。</p>';
    $content .= '<form method="post" action="' . base_path() . '/admin/reset-data">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<div class="grid">';
    $content .= '<div><label>输入“确认删除”继续</label><input class="input" name="confirm_phrase" placeholder="确认删除" required></div>';
    $content .= '</div>';
    $content .= '<div style="margin-top:12px"><button class="button danger" type="submit">删除所有数据</button></div>';
    $content .= '</form></div>';
$content .= '<div class="modal admin-comment-modal" data-admin-comment-modal hidden>';
    $content .= '<div class="modal-backdrop" data-modal-close></div>';
    $content .= '<div class="modal-card">';
    $content .= '<div class="modal-header">编辑评论</div>';
    $content .= '<form method="post" action="' . base_path() . '/admin/comment/edit" data-admin-comment-form>';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<input type="hidden" name="comment_id" value="" data-admin-comment-id>';
    $content .= '<div class="modal-body">';
    $content .= '<div class="muted" data-admin-comment-note hidden></div>';
    $content .= '<textarea class="input" name="content" rows="6" placeholder="请输入评论内容" data-admin-comment-content required></textarea>';
    $content .= '</div>';
    $content .= '<div class="modal-actions">';
    $content .= '<button class="button" type="button" data-modal-close>取消</button>';
    $content .= '<button class="button primary" type="submit">保存修改</button>';
    $content .= '</div>';
    $content .= '</form>';
    $content .= '</div>';
    $content .= '</div>';

    $content .= '<div class="modal" data-user-modal hidden>';
    $content .= '<div class="modal-backdrop" data-modal-close></div>';
    $content .= '<div class="modal-card">';
    $content .= '<div class="modal-header">编辑用户</div>';
    $content .= '<form method="post" action="' . base_path() . '/admin/user-update" class="modal-form">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<input type="hidden" name="user_id" value="" data-user-field="id">';
    $content .= '<div class="grid">';
    $content .= '<div><label>用户名</label><input class="input" name="username" data-user-field="username" required></div>';
    $content .= '<div><label>邮箱</label><input class="input" name="email" data-user-field="email"></div>';
    $content .= '<div><label>角色</label><select class="input" name="role" data-user-field="role"><option value="user">普通用户</option><option value="admin">管理员</option></select></div>';
    $content .= '<div><label>状态</label><select class="input" name="disabled" data-user-field="disabled"><option value="0">正常</option><option value="1">禁用</option></select></div>';
    $content .= '<div><label>存储上限 (MB)</label><input class="input" name="limit_mb" type="number" min="0" data-user-field="limit"></div>';
    $content .= '<div><label>新密码（留空不修改）</label><input class="input" name="password" type="password" placeholder="********"></div>';
    $content .= '</div>';
    $content .= '<div class="modal-actions">';
    $content .= '<button class="button ghost" type="button" data-modal-close>取消</button>';
    $content .= '<button class="button primary" type="submit">保存</button>';
    $content .= '</div>';
    $content .= '</form>';
    $content .= '</div>';
    $content .= '</div>';
    $createModalHidden = $createOpen ? '' : ' hidden';
    $roleAdminSelected = $createRole === 'admin' ? ' selected' : '';
    $roleUserSelected = $createRole !== 'admin' ? ' selected' : '';
    $disabledSelected = $createDisabled === '1' ? ' selected' : '';
    $activeSelected = $createDisabled === '1' ? '' : ' selected';
    $content .= '<div class="modal" data-user-create-modal' . $createModalHidden . '>';
    $content .= '<div class="modal-backdrop" data-modal-close></div>';
    $content .= '<div class="modal-card">';
    $content .= '<div class="modal-header">添加账号</div>';
    $content .= '<form method="post" action="' . base_path() . '/admin/user-create" class="modal-form">';
    $content .= '<input type="hidden" name="csrf" value="' . csrf_token() . '">';
    $content .= '<div class="grid">';
    $content .= '<div><label>用户名</label><input class="input" name="username" value="' . htmlspecialchars($createUsername) . '" required></div>';
    $content .= '<div><label>邮箱</label><input class="input" name="email" value="' . htmlspecialchars($createEmail) . '"></div>';
    $content .= '<div><label>角色</label><select class="input" name="role"><option value="user"' . $roleUserSelected . '>普通用户</option><option value="admin"' . $roleAdminSelected . '>管理员</option></select></div>';
    $content .= '<div><label>状态</label><select class="input" name="disabled"><option value="0"' . $activeSelected . '>正常</option><option value="1"' . $disabledSelected . '>禁用</option></select></div>';
    $content .= '<div><label>存储上限 (MB)</label><input class="input" name="limit_mb" type="number" min="0" value="' . htmlspecialchars($createLimitMb) . '"></div>';
    $content .= '<div><label>密码</label><input class="input" name="password" type="password" value="' . htmlspecialchars($createPassword) . '" required></div>';
    $content .= '</div>';
    $content .= '<div class="modal-actions">';
    $content .= '<button class="button ghost" type="button" data-modal-close>取消</button>';
    $content .= '<button class="button primary" type="submit">添加</button>';
    $content .= '</div>';
    $content .= '</form>';
    $content .= '</div>';
    $content .= '</div>';
    $titleHtml = build_topbar_title('后台', $admin);
    render_page('后台', $content, $admin, '', ['layout' => 'app', 'nav' => 'admin-settings', 'title_html' => $titleHtml]);
}

if ($path === '/admin/settings' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $allowRegistration = isset($_POST['allow_registration']) ? '1' : '0';
    $captchaEnabled = isset($_POST['captcha_enabled']) ? '1' : '0';
    $emailVerifyEnabled = isset($_POST['email_verification_enabled']) ? '1' : '0';
    $smtpEnabled = isset($_POST['smtp_enabled']) ? '1' : '0';
    $defaultLimitMb = max(0, (int)($_POST['default_storage_limit_mb'] ?? 0));
    $emailFrom = trim((string)($_POST['email_from'] ?? ''));
    $emailFromName = trim((string)($_POST['email_from_name'] ?? ''));
    $emailSubject = trim((string)($_POST['email_subject'] ?? ''));
    $emailResetSubject = trim((string)($_POST['email_reset_subject'] ?? ''));
    $siteIcp = trim((string)($_POST['site_icp'] ?? ''));
    $siteContactEmail = trim((string)($_POST['site_contact_email'] ?? ''));
    $siteBaseUrl = trim((string)($_POST['site_base_url'] ?? ''));
    $smtpHost = trim((string)($_POST['smtp_host'] ?? ''));
    $smtpPort = trim((string)($_POST['smtp_port'] ?? ''));
    $smtpSecure = trim((string)($_POST['smtp_secure'] ?? ''));
    $smtpUser = trim((string)($_POST['smtp_user'] ?? ''));
    $smtpPass = trim((string)($_POST['smtp_pass'] ?? ''));
    $bannedWords = trim((string)($_POST['banned_words'] ?? ''));
    if ($bannedWords !== '') {
        $bannedWords = str_replace(["\r\n", "\n", "\r"], '|', $bannedWords);
    }
    set_setting('allow_registration', $allowRegistration);
    set_setting('captcha_enabled', $captchaEnabled);
    set_setting('email_verification_enabled', $emailVerifyEnabled);
    set_setting('smtp_enabled', $smtpEnabled);
    set_setting('default_storage_limit_bytes', (string)bytes_from_mb($defaultLimitMb));
    set_setting('email_from', $emailFrom);
    set_setting('email_from_name', $emailFromName);
    set_setting('email_subject', $emailSubject);
    set_setting('email_reset_subject', $emailResetSubject);
    set_setting('site_icp', $siteIcp);
    set_setting('site_contact_email', $siteContactEmail);
    set_setting('site_base_url', $siteBaseUrl);
    set_setting('smtp_host', $smtpHost);
    set_setting('smtp_port', $smtpPort !== '' ? $smtpPort : '587');
    set_setting('smtp_secure', $smtpSecure !== '' ? $smtpSecure : 'tls');
    set_setting('smtp_user', $smtpUser);
    set_setting('smtp_pass', $smtpPass);
    set_setting('banned_words', $bannedWords);
    flash('info', '站点设置已更新');
    redirect('/admin#settings');
}

if ($path === '/admin/announcement/create' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $admin = require_admin();
    check_csrf();
    $title = trim((string)($_POST['title'] ?? ''));
    $content = trim((string)($_POST['content'] ?? ''));
    $active = isset($_POST['active']) ? 1 : 0;
    if ($title === '' || $content === '') {
        flash('error', '公告标题和内容不能为空');
        redirect('/admin#announcements');
    }
    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO announcements (title, content, active, created_by, created_at)
        VALUES (:title, :content, :active, :created_by, :created_at)');
    $stmt->execute([
        ':title' => $title,
        ':content' => $content,
        ':active' => $active,
        ':created_by' => $admin['id'],
        ':created_at' => now(),
    ]);
    flash('info', '公告已发布');
    redirect('/admin#announcements');
}

if ($path === '/admin/announcement/update' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $id = (int)($_POST['announcement_id'] ?? 0);
    $title = trim((string)($_POST['title'] ?? ''));
    $content = trim((string)($_POST['content'] ?? ''));
    $active = isset($_POST['active']) ? 1 : 0;
    if ($id <= 0 || $title === '' || $content === '') {
        flash('error', '公告标题和内容不能为空');
        redirect('/admin#announcements');
    }
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE announcements SET title = :title, content = :content, active = :active WHERE id = :id');
    $stmt->execute([
        ':title' => $title,
        ':content' => $content,
        ':active' => $active,
        ':id' => $id,
    ]);
    flash('info', '公告已更新');
    redirect('/admin#announcements');
}

if ($path === '/admin/announcement/toggle' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $id = (int)($_POST['announcement_id'] ?? 0);
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE announcements SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = :id');
    $stmt->execute([':id' => $id]);
    flash('info', '公告状态已更新');
    redirect('/admin#announcements');
}

if ($path === '/admin/announcement/delete' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $id = (int)($_POST['announcement_id'] ?? 0);
    $pdo = db();
    $stmt = $pdo->prepare('DELETE FROM announcements WHERE id = :id');
    $stmt->execute([':id' => $id]);
    flash('info', '公告已删除');
    redirect('/admin#announcements');
}

if ($path === '/admin/smtp-test' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $email = trim((string)($_POST['test_email'] ?? ''));
    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        flash('error', '请输入有效的测试邮箱');
        redirect('/admin#settings');
    }
    if (!smtp_enabled()) {
        flash('error', '请先启用 SMTP');
        redirect('/admin#settings');
    }
    $sent = send_mail($email, 'SMTP 测试邮件', '这是一封 SMTP 配置测试邮件。');
    if ($sent) {
        flash('info', '测试邮件发送成功');
    } else {
        $detail = trim((string)($GLOBALS['smtp_last_error'] ?? ''));
        $message = $detail !== '' ? '测试邮件发送失败：' . $detail : '测试邮件发送失败';
        flash('error', $message);
    }
    redirect('/admin#settings');
}

if ($path === '/admin/user-batch' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $admin = require_admin();
    check_csrf();
    $ids = $_POST['user_ids'] ?? [];
    $action = (string)($_POST['action'] ?? '');
    $ids = array_unique(array_filter(array_map('intval', is_array($ids) ? $ids : [$ids])));
    if (empty($ids)) {
        flash('error', '请先选择用户');
        redirect('/admin#users');
    }
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE users SET disabled = :disabled WHERE id = :id AND role != "admin"');
    $updated = 0;
    $deleted = 0;
    foreach ($ids as $userId) {
        if ($userId === (int)$admin['id']) {
            continue;
        }
        if ($action === 'delete') {
            if (delete_user_account($userId)) {
                $deleted++;
            }
            continue;
        }
        if ($action === 'disable') {
            $stmt->execute([':disabled' => 1, ':id' => $userId]);
            $updated++;
        } elseif ($action === 'enable') {
            $stmt->execute([':disabled' => 0, ':id' => $userId]);
            $updated++;
        }
    }
    if ($action === 'delete') {
        flash('info', '已删除 ' . $deleted . ' 个用户');
    } else {
        flash('info', '已处理 ' . $updated . ' 个用户');
    }
    redirect('/admin#users');
}

if ($path === '/admin/user-delete' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $admin = require_admin();
    check_csrf();
    $userId = (int)($_POST['user_id'] ?? 0);
    if ($userId <= 0 || $userId === (int)$admin['id']) {
        flash('error', '无法删除该用户');
        redirect('/admin#users');
    }
    if (!delete_user_account($userId)) {
        flash('error', '删除用户失败');
        redirect('/admin#users');
    }
    flash('info', '用户已删除');
    redirect('/admin#users');
}

if ($path === '/admin/user-create' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $username = trim((string)($_POST['username'] ?? ''));
    $email = trim((string)($_POST['email'] ?? ''));
    $role = (string)($_POST['role'] ?? 'user');
    $disabled = (int)($_POST['disabled'] ?? 0);
    $limitMb = max(0, (int)($_POST['limit_mb'] ?? 0));
    $password = (string)($_POST['password'] ?? '');
    if (!in_array($role, ['admin', 'user'], true)) {
        $role = 'user';
    }
    $createForm = [
        'open' => 1,
        'username' => $username,
        'email' => $email,
        'role' => $role,
        'disabled' => (string)($disabled ? 1 : 0),
        'limit_mb' => (string)$limitMb,
        'password' => $password,
    ];
    if ($username === '' || $password === '') {
        $_SESSION['user_create_form'] = $createForm;
        flash('error', '请输入用户名和密码');
        redirect('/admin#users');
    }
    if (strlen($password) < 6) {
        $_SESSION['user_create_form'] = $createForm;
        flash('error', '密码至少 6 位');
        redirect('/admin#users');
    }
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        $_SESSION['user_create_form'] = $createForm;
        flash('error', '邮箱格式不正确');
        redirect('/admin#users');
    }
    $pdo = db();
    if ($email !== '') {
        $checkEmail = $pdo->prepare('SELECT id FROM users WHERE email = :email LIMIT 1');
        $checkEmail->execute([':email' => $email]);
        if ($checkEmail->fetch()) {
            $_SESSION['user_create_form'] = $createForm;
            flash('error', '邮箱已被其他账号使用');
            redirect('/admin#users');
        }
    }
    $check = $pdo->prepare('SELECT id FROM users WHERE username = :username LIMIT 1');
    $check->execute([':username' => $username]);
    if ($check->fetch()) {
        $_SESSION['user_create_form'] = $createForm;
        flash('error', '用户名已存在');
        redirect('/admin#users');
    }
    $passwordHash = password_hash($password, PASSWORD_DEFAULT);
    $emailVerified = $email !== '' ? 1 : 0;
    $stmt = $pdo->prepare('INSERT INTO users (username, email, password_hash, role, api_key_hash, api_key_prefix, api_key_last4, disabled, storage_limit_bytes, storage_used_bytes, must_change_password, email_verified, created_at, updated_at)
        VALUES (:username, :email, :password_hash, :role, :api_key_hash, :api_key_prefix, :api_key_last4, :disabled, :storage_limit_bytes, :storage_used_bytes, :must_change_password, :email_verified, :created_at, :updated_at)');
    try {
        $stmt->execute([
            ':username' => $username,
            ':email' => $email,
            ':password_hash' => $passwordHash,
            ':role' => $role,
            ':api_key_hash' => null,
            ':api_key_prefix' => null,
            ':api_key_last4' => null,
            ':disabled' => $disabled ? 1 : 0,
            ':storage_limit_bytes' => bytes_from_mb($limitMb),
            ':storage_used_bytes' => 0,
            ':must_change_password' => 0,
            ':email_verified' => $emailVerified,
            ':created_at' => now(),
            ':updated_at' => now(),
        ]);
    } catch (PDOException $e) {
        $_SESSION['user_create_form'] = $createForm;
        flash('error', '账号创建失败');
        redirect('/admin#users');
    }
    unset($_SESSION['user_create_form']);
    flash('info', '账号已添加');
    redirect('/admin#users');
}

if ($path === '/admin/user-update' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $admin = require_admin();
    check_csrf();
    $userId = (int)($_POST['user_id'] ?? 0);
    $username = trim((string)($_POST['username'] ?? ''));
    $email = trim((string)($_POST['email'] ?? ''));
    $role = (string)($_POST['role'] ?? 'user');
    $disabled = (int)($_POST['disabled'] ?? 0);
    $limitMb = max(0, (int)($_POST['limit_mb'] ?? 0));
    $password = (string)($_POST['password'] ?? '');
    if ($userId <= 0 || $username === '') {
        flash('error', '请输入有效的用户名');
        redirect('/admin#users');
    }
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        flash('error', '邮箱格式不正确');
        redirect('/admin#users');
    }
    if (!in_array($role, ['admin', 'user'], true)) {
        $role = 'user';
    }
    if ($userId === (int)$admin['id']) {
        $role = 'admin';
        $disabled = 0;
    }
    $pdo = db();
    if ($email !== '') {
        $checkEmail = $pdo->prepare('SELECT id FROM users WHERE email = :email AND id != :id');
        $checkEmail->execute([':email' => $email, ':id' => $userId]);
        if ($checkEmail->fetch()) {
            flash('error', '邮箱已被其他账号使用');
            redirect('/admin#users');
        }
    }
    $check = $pdo->prepare('SELECT id FROM users WHERE username = :username AND id != :id');
    $check->execute([':username' => $username, ':id' => $userId]);
    if ($check->fetch()) {
        flash('error', '用户名已存在');
        redirect('/admin#users');
    }
    $stmt = $pdo->prepare('UPDATE users SET username = :username, email = :email, role = :role, disabled = :disabled, storage_limit_bytes = :limit, updated_at = :updated_at WHERE id = :id');
    $stmt->execute([
        ':username' => $username,
        ':email' => $email,
        ':role' => $role,
        ':disabled' => $disabled ? 1 : 0,
        ':limit' => bytes_from_mb($limitMb),
        ':updated_at' => now(),
        ':id' => $userId,
    ]);
    if ($password !== '') {
        $pwd = $pdo->prepare('UPDATE users SET password_hash = :hash, updated_at = :updated_at WHERE id = :id');
        $pwd->execute([
            ':hash' => password_hash($password, PASSWORD_DEFAULT),
            ':updated_at' => now(),
            ':id' => $userId,
        ]);
    }
    flash('info', '用户信息已更新');
    redirect('/admin#users');
}

if ($path === '/admin/share-batch' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $ids = $_POST['share_ids'] ?? [];
    $action = (string)($_POST['action'] ?? '');
    $ids = array_unique(array_filter(array_map('intval', is_array($ids) ? $ids : [$ids])));
    if (empty($ids)) {
        flash('error', '请先选择分享');
        redirect('/admin#shares');
    }
    $pdo = db();
    $ownerStmt = $pdo->prepare('SELECT user_id FROM shares WHERE id = :id');
    $softStmt = $pdo->prepare('UPDATE shares SET deleted_at = :deleted_at WHERE id = :id');
    $restoreStmt = $pdo->prepare('UPDATE shares SET deleted_at = NULL WHERE id = :id');
    $affectedOwners = [];
    foreach ($ids as $shareId) {
        $ownerStmt->execute([':id' => $shareId]);
        $ownerId = (int)($ownerStmt->fetchColumn() ?: 0);
        if ($action === 'soft_delete') {
            $softStmt->execute([':deleted_at' => now(), ':id' => $shareId]);
            purge_share_access_logs($shareId);
        } elseif ($action === 'restore') {
            $restoreStmt->execute([':id' => $shareId]);
        } elseif ($action === 'hard_delete') {
            hard_delete_share($shareId);
        }
        if ($ownerId) {
            $affectedOwners[$ownerId] = true;
        }
    }
    foreach (array_keys($affectedOwners) as $ownerId) {
        recalculate_user_storage($ownerId);
    }
    flash('info', '批量操作已完成');
    redirect('/admin#shares');
}

if ($path === '/admin/scan/batch' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $action = (string)($_POST['action'] ?? '');
    $pairs = $_POST['scan_ids'] ?? [];
    $pairs = is_array($pairs) ? $pairs : [$pairs];
    if (empty($pairs)) {
        flash('error', '请先选择记录');
        redirect('/admin#scan');
    }
    $shareIds = [];
    $userIds = [];
    foreach ($pairs as $value) {
        $parts = explode('|', (string)$value, 2);
        $shareId = (int)($parts[0] ?? 0);
        $userId = (int)($parts[1] ?? 0);
        if ($shareId) {
            $shareIds[$shareId] = true;
        }
        if ($userId) {
            $userIds[$userId] = true;
        }
    }
    $pdo = db();
    if ($action === 'delete' && !empty($shareIds)) {
        $stmt = $pdo->prepare('UPDATE shares SET deleted_at = :deleted_at WHERE id = :id AND deleted_at IS NULL');
        foreach (array_keys($shareIds) as $shareId) {
            $stmt->execute([':deleted_at' => now(), ':id' => $shareId]);
            purge_share_access_logs($shareId);
        }
        flash('info', '已删除 ' . count($shareIds) . ' 个违规分享');
        redirect('/admin#scan');
    }
    if ($action === 'disable' && !empty($userIds)) {
        $stmt = $pdo->prepare('UPDATE users SET disabled = 1 WHERE id = :id AND role != "admin"');
        foreach (array_keys($userIds) as $userId) {
            $stmt->execute([':id' => $userId]);
        }
        flash('info', '已停用 ' . count($userIds) . ' 个违规账号');
        redirect('/admin#scan');
    }
    flash('error', '未找到可处理的记录');
    redirect('/admin#scan');
}

if ($path === '/admin/user-toggle' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $admin = require_admin();
    check_csrf();
    $userId = (int)($_POST['user_id'] ?? 0);
    if ($userId === (int)$admin['id']) {
        flash('error', '不能禁用自己');
        redirect('/admin#users');
    }
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE users SET disabled = CASE WHEN disabled = 1 THEN 0 ELSE 1 END WHERE id = :id');
    $stmt->execute([':id' => $userId]);
    flash('info', '用户状态已更新');
    redirect('/admin#users');
}

if ($path === '/admin/user-role' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $admin = require_admin();
    check_csrf();
    $userId = (int)($_POST['user_id'] ?? 0);
    if ($userId === (int)$admin['id']) {
        flash('error', '不能修改自己的角色');
        redirect('/admin#users');
    }
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE users SET role = CASE WHEN role = "admin" THEN "user" ELSE "admin" END WHERE id = :id');
    $stmt->execute([':id' => $userId]);
    flash('info', '用户角色已更新');
    redirect('/admin#users');
}

if ($path === '/admin/user-limit' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $userId = (int)($_POST['user_id'] ?? 0);
    $limitMb = max(0, (int)($_POST['limit_mb'] ?? 0));
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE users SET storage_limit_bytes = :limit WHERE id = :id');
    $stmt->execute([
        ':limit' => bytes_from_mb($limitMb),
        ':id' => $userId,
    ]);
    flash('info', '用户存储上限已更新');
    redirect('/admin#users');
}

if ($path === '/admin/share-delete' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $shareId = (int)($_POST['share_id'] ?? 0);
    $pdo = db();
    $ownerStmt = $pdo->prepare('SELECT user_id FROM shares WHERE id = :id');
    $ownerStmt->execute([':id' => $shareId]);
    $ownerId = (int)($ownerStmt->fetchColumn() ?: 0);
    $stmt = $pdo->prepare('UPDATE shares SET deleted_at = :deleted_at WHERE id = :id');
    $stmt->execute([
        ':deleted_at' => now(),
        ':id' => $shareId,
    ]);
    purge_share_access_logs($shareId);
    if ($ownerId) {
        recalculate_user_storage($ownerId);
    }
    flash('info', '分享已软删除');
    redirect('/admin#shares');
}

if ($path === '/admin/share-restore' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $shareId = (int)($_POST['share_id'] ?? 0);
    $pdo = db();
    $ownerStmt = $pdo->prepare('SELECT user_id FROM shares WHERE id = :id');
    $ownerStmt->execute([':id' => $shareId]);
    $ownerId = (int)($ownerStmt->fetchColumn() ?: 0);
    $stmt = $pdo->prepare('UPDATE shares SET deleted_at = NULL WHERE id = :id');
    $stmt->execute([':id' => $shareId]);
    if ($ownerId) {
        recalculate_user_storage($ownerId);
    }
    flash('info', '分享已恢复');
    redirect('/admin#shares');
}

if ($path === '/admin/share-hard-delete' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $shareId = (int)($_POST['share_id'] ?? 0);
    $deleted = hard_delete_share($shareId);
    if ($deleted === null) {
        flash('error', '分享不存在');
    } else {
        flash('info', '分享已彻底删除');
    }
    redirect('/admin#shares');
}

if ($path === '/admin/report-handle' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $admin = require_admin();
    check_csrf();
    $reportId = (int)($_POST['report_id'] ?? 0);
    if ($reportId <= 0) {
        flash('error', '举报不存在');
        redirect('/admin#reports');
    }
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE share_reports SET handled_at = :handled_at, handled_by = :handled_by WHERE id = :id');
    $stmt->execute([
        ':handled_at' => now(),
        ':handled_by' => (int)$admin['id'],
        ':id' => $reportId,
    ]);
    flash('info', '举报已处理');
    redirect('/admin#reports');
}

if ($path === '/admin/report-share-delete' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $admin = require_admin();
    check_csrf();
    $reportId = (int)($_POST['report_id'] ?? 0);
    if ($reportId <= 0) {
        flash('error', '举报不存在');
        redirect('/admin#reports');
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT share_id FROM share_reports WHERE id = :id');
    $stmt->execute([':id' => $reportId]);
    $shareId = (int)($stmt->fetchColumn() ?: 0);
    if ($shareId <= 0) {
        flash('error', '分享不存在');
        redirect('/admin#reports');
    }
    $deleted = hard_delete_share($shareId);
    if ($deleted === null) {
        flash('error', '分享不存在');
        redirect('/admin#reports');
    }
    flash('info', '分享已彻底删除');
    redirect('/admin#reports');
}

if ($path === '/admin/report-user-disable' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $admin = require_admin();
    check_csrf();
    $reportId = (int)($_POST['report_id'] ?? 0);
    $pdo = db();
    if ($reportId <= 0) {
        flash('error', '举报不存在');
        redirect('/admin#reports');
    }
    $stmt = $pdo->prepare('SELECT share_user_id FROM share_reports WHERE id = :id');
    $stmt->execute([':id' => $reportId]);
    $userId = (int)($stmt->fetchColumn() ?: 0);
    if ($userId <= 0) {
        flash('error', '用户不存在');
        redirect('/admin#reports');
    }
    $roleStmt = $pdo->prepare('SELECT role FROM users WHERE id = :id');
    $roleStmt->execute([':id' => $userId]);
    $role = (string)($roleStmt->fetchColumn() ?? '');
    if ($role === 'admin') {
        flash('error', '无法禁用管理员账号');
        redirect('/admin#reports');
    }
    $stmt = $pdo->prepare('UPDATE users SET disabled = 1 WHERE id = :id');
    $stmt->execute([':id' => $userId]);
    $pdo->prepare('UPDATE share_reports SET handled_at = :handled_at, handled_by = :handled_by WHERE id = :id')
        ->execute([
            ':handled_at' => now(),
            ':handled_by' => (int)$admin['id'],
            ':id' => $reportId,
        ]);
    flash('info', '账号已禁用');
    redirect('/admin#reports');
}

if ($path === '/admin/report-delete' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $reportId = (int)($_POST['report_id'] ?? 0);
    if ($reportId <= 0) {
        flash('error', '举报不存在');
        redirect('/admin#reports');
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT handled_at FROM share_reports WHERE id = :id');
    $stmt->execute([':id' => $reportId]);
    $handledAt = (string)($stmt->fetchColumn() ?? '');
    if ($handledAt === '') {
        flash('error', '请先处理举报再删除');
        redirect('/admin#reports');
    }
    $pdo->prepare('DELETE FROM share_reports WHERE id = :id')->execute([':id' => $reportId]);
    flash('info', '举报记录已删除');
    redirect('/admin#reports');
}

if ($path === '/admin/report-batch' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $ids = $_POST['report_ids'] ?? [];
    $action = (string)($_POST['action'] ?? '');
    $ids = array_unique(array_filter(array_map('intval', is_array($ids) ? $ids : [$ids])));
    if (empty($ids) || $action !== 'delete') {
        flash('error', '请先选择要删除的举报');
        redirect('/admin#reports');
    }
    $pdo = db();
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $del = $pdo->prepare('DELETE FROM share_reports WHERE id IN (' . $placeholders . ')');
    $del->execute($ids);
    $deleted = $del->rowCount();
    flash('info', '已删除 ' . $deleted . ' 条举报');
    redirect('/admin#reports');
}

if ($path === '/admin/chunk-delete' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    global $config;
    $chunkId = trim((string)($_POST['chunk_id'] ?? ''));
    if ($chunkId === '' || !preg_match('/^[a-zA-Z0-9_-]+$/', $chunkId)) {
        redirect('/admin#chunks');
    }
    $path = $config['uploads_dir'] . '/chunks/' . $chunkId;
    remove_dir($path);
    $stage = $config['uploads_dir'] . '/staging/' . $chunkId;
    remove_dir($stage);
    redirect('/admin#chunks');
}

if ($path === '/admin/chunk-clean' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    global $config;
    [$ttl] = chunk_cleanup_settings();
    $stale = list_stale_chunks($ttl);
    foreach ($stale as $chunk) {
        $chunkId = (string)($chunk['id'] ?? '');
        if ($chunkId === '' || !preg_match('/^[a-zA-Z0-9_-]+$/', $chunkId)) {
            continue;
        }
        $path = $config['uploads_dir'] . '/chunks/' . $chunkId;
        remove_dir($path);
        $stage = $config['uploads_dir'] . '/staging/' . $chunkId;
        remove_dir($stage);
    }
    redirect('/admin#chunks');
}

if ($path === '/admin/scan/start' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $words = get_banned_words();
    if (empty($words)) {
        api_response(400, null, '请先设置违禁词');
    }
    $total = count_scannable_docs();
    $_SESSION['scan_results'] = [];
    $_SESSION['scan_logs'] = [];
    $_SESSION['scan_done'] = 0;
    $_SESSION['scan_at'] = time();
    $_SESSION['scan_total'] = $total;
    api_response(200, ['total' => $total]);
}

if ($path === '/admin/scan/step' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $words = get_banned_words();
    if (empty($words)) {
        api_response(400, null, '请先设置违禁词');
    }
    $offset = max(0, (int)($_POST['offset'] ?? 0));
    $limit = max(1, min(200, (int)($_POST['limit'] ?? 50)));
    $total = (int)($_SESSION['scan_total'] ?? count_scannable_docs());
    $batch = scan_banned_shares_batch($words, $offset, $limit);
    $existing = $_SESSION['scan_results'] ?? [];
    if (!is_array($existing)) {
        $existing = [];
    }
    $existing = array_merge($existing, $batch['hits']);
    $_SESSION['scan_results'] = $existing;
    $existingLogs = $_SESSION['scan_logs'] ?? [];
    if (!is_array($existingLogs)) {
        $existingLogs = [];
    }
    $existingLogs = array_merge($existingLogs, $batch['logs']);
    $_SESSION['scan_logs'] = $existingLogs;
    $_SESSION['scan_at'] = time();
    $nextOffset = $offset + (int)$batch['count'];
    $done = $nextOffset >= $total || $batch['count'] === 0;
    $_SESSION['scan_done'] = $done ? 1 : 0;
    api_response(200, [
        'nextOffset' => $nextOffset,
        'done' => $done,
        'hitCount' => count($existing),
        'logs' => $batch['logs'],
        'total' => $total,
    ]);
}

if ($path === '/admin/scan' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $words = get_banned_words();
    if (empty($words)) {
        flash('error', '请先设置违禁词');
        redirect('/admin#scan');
    }
    $results = scan_banned_shares($words);
    $_SESSION['scan_results'] = $results;
    $_SESSION['scan_logs'] = [];
    $_SESSION['scan_done'] = 1;
    $_SESSION['scan_at'] = time();
    flash('info', '扫描完成，共命中 ' . count($results) . ' 条记录');
    redirect('/admin#scan');
}

if ($path === '/admin/scan/delete' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $results = $_SESSION['scan_results'] ?? [];
    if (empty($results) || !is_array($results)) {
        flash('error', '暂无扫描结果');
        redirect('/admin#scan');
    }
    $shareIds = [];
    foreach ($results as $hit) {
        if (isset($hit['share_id'])) {
            $shareIds[(int)$hit['share_id']] = true;
        }
    }
    if (empty($shareIds)) {
        flash('error', '暂无可删除分享');
        redirect('/admin#scan');
    }
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE shares SET deleted_at = :deleted_at WHERE id = :id AND deleted_at IS NULL');
    foreach (array_keys($shareIds) as $shareId) {
        $stmt->execute([':deleted_at' => now(), ':id' => $shareId]);
    }
    flash('info', '已删除 ' . count($shareIds) . ' 个违规分享');
    redirect('/admin#scan');
}

if ($path === '/admin/scan/disable' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $results = $_SESSION['scan_results'] ?? [];
    if (empty($results) || !is_array($results)) {
        flash('error', '暂无扫描结果');
        redirect('/admin#scan');
    }
    $userIds = [];
    foreach ($results as $hit) {
        if (isset($hit['user_id'])) {
            $userIds[(int)$hit['user_id']] = true;
        }
    }
    if (empty($userIds)) {
        flash('error', '暂无可停用账号');
        redirect('/admin#scan');
    }
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE users SET disabled = 1 WHERE id = :id AND role != "admin"');
    foreach (array_keys($userIds) as $userId) {
        $stmt->execute([':id' => $userId]);
    }
    flash('info', '已停用 ' . count($userIds) . ' 个违规账号');
    redirect('/admin#scan');
}

if ($path === '/admin/comment/edit' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $commentId = max(0, (int)($_POST['comment_id'] ?? 0));
    $content = trim((string)($_POST['content'] ?? ''));
    if ($commentId <= 0) {
        flash('error', '缺少评论ID');
        redirect('/admin#scan');
    }
    if ($content === '') {
        flash('error', '评论内容不能为空');
        redirect('/admin#scan');
    }
    $contentLength = function_exists('mb_strlen') ? mb_strlen($content, 'UTF-8') : strlen($content);
    if ($contentLength > 2000) {
        flash('error', '评论内容过长');
        redirect('/admin#scan');
    }
    $bannedWords = get_banned_words();
    if (!empty($bannedWords)) {
        $hit = find_banned_word($content, $bannedWords);
        if ($hit) {
            flash('error', '触发违禁词：' . $hit['word']);
            redirect('/admin#scan');
        }
    }
    $pdo = db();
    $stmt = $pdo->prepare('SELECT share_comments.*, shares.user_id AS share_user_id FROM share_comments
        JOIN shares ON share_comments.share_id = shares.id
        WHERE share_comments.id = :id');
    $stmt->execute([':id' => $commentId]);
    $comment = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$comment) {
        flash('error', '评论不存在');
        redirect('/admin#scan');
    }
    $shareId = (int)($comment['share_id'] ?? 0);
    $shareUserId = (int)($comment['share_user_id'] ?? 0);
    if ($shareId <= 0 || $shareUserId <= 0) {
        flash('error', '评论关联的分享不存在');
        redirect('/admin#scan');
    }
    $commentEmail = (string)($comment['email'] ?? '');
    $newSize = calculate_comment_size($commentEmail, $content);
    $oldSize = (int)($comment['size_bytes'] ?? 0);
    $oldAssets = extract_comment_asset_paths((string)($comment['content'] ?? ''), $shareId);
    $newAssets = extract_comment_asset_paths($content, $shareId);
    $removeAssets = array_values(array_diff($oldAssets, $newAssets));
    if (!empty($removeAssets)) {
        $removeAssets = filter_unused_comment_assets($shareId, $removeAssets, [$commentId]);
    }
    $removeAssetSize = sum_share_asset_sizes($shareId, $removeAssets);
    $delta = $newSize - $oldSize;
    $netDelta = $delta - $removeAssetSize;
    if ($netDelta > 0) {
        $owner = get_user_by_id($shareUserId);
        if (!$owner) {
            flash('error', '分享所属用户不存在');
            redirect('/admin#scan');
        }
        $used = recalculate_user_storage((int)$owner['id']);
        $limit = get_user_limit_bytes($owner);
        if ($limit > 0 && ($used + $netDelta) > $limit) {
            flash('error', '存储空间不足，无法保存修改');
            redirect('/admin#scan');
        }
    }
    $update = $pdo->prepare('UPDATE share_comments SET content = :content, size_bytes = :size_bytes WHERE id = :id');
    $update->execute([
        ':content' => $content,
        ':size_bytes' => $newSize,
        ':id' => $commentId,
    ]);
    $deletedAssetSize = delete_comment_assets($shareId, $removeAssets);
    $totalDelta = $delta - $deletedAssetSize;
    if ($totalDelta !== 0) {
        adjust_share_size($shareId, $totalDelta);
        adjust_user_storage($shareUserId, $totalDelta);
    }
    flash('info', '评论已更新');
    redirect('/admin#scan');
}

if ($path === '/admin/reset-data' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_admin();
    check_csrf();
    $phrase = trim((string)($_POST['confirm_phrase'] ?? ''));
    if ($phrase !== '确认删除') {
        flash('error', '确认口令错误');
        redirect('/admin');
    }
    reset_database();
    $_SESSION = [];
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_regenerate_id(true);
    }
    flash('info', '数据已重置，请使用默认管理员登录');
    redirect('/login');
}

if ($path === '/') {
    $user = current_user();
    if ($user) {
        redirect('/dashboard');
    }
    $allowRegistration = allow_registration();
    $siteIcp = get_setting('site_icp', '');
    $siteContactEmail = get_setting('site_contact_email', '');
    $appName = htmlspecialchars($config['app_name']);
    $versionText = site_version();
    $versionHtml = '';
    if ($versionText !== '') {
        $versionLabel = $versionText;
        if (stripos($versionLabel, 'v') !== 0) {
            $versionLabel = 'v' . $versionLabel;
        }
        $versionHtml = '<span class="home-version">' . htmlspecialchars($versionLabel) . '</span>';
    }
    $loginUrl = base_path() . '/login';
    $registerUrl = base_path() . '/register';

    $content = '<section class="home-hero">';
    $content .= '<div class="home-hero__main">';
    $content .= '<div class="home-badge">官方 Markdown 导出</div>';
    $content .= '<h1 class="home-title">' . $appName . $versionHtml . '</h1>';
    $content .= '<p class="home-lead">让文档与笔记本以可控的外链分享：自动同步、密码与到期控制、统一链接管理。</p>';
    $content .= '<div class="home-actions">';
    $content .= '<a class="button primary" href="' . $loginUrl . '">立即登录</a>';
    if ($allowRegistration) {
        $content .= '<a class="button" href="' . $registerUrl . '">注册账号</a>';
    }
    $content .= '</div>';
    $content .= '<div class="home-hero__meta">支持文档 / 笔记本 · 权限可控 · 多用户协作</div>';
    $content .= '</div>';
    $content .= '<div class="home-hero__visual">';
    $content .= '<div class="hero-card hero-card--preview">';
    $content .= '<div class="hero-card__title">分享预览</div>';
    $content .= '<div class="hero-card__lines"><span></span><span></span><span></span><span></span></div>';
    $content .= '<div class="hero-card__chips"><span>访问 128</span><span>到期 2026-01-10</span><span>密码保护</span></div>';
    $content .= '</div>';
    $content .= '<div class="hero-card hero-card--flow">';
    $content .= '<div class="hero-card__title">同步流程</div>';
    $content .= '<ol class="hero-flow"><li>生成 API Key</li><li>一键验证同步</li><li>复制链接分享</li></ol>';
    $content .= '</div>';
    $content .= '</div>';
    $content .= '</section>';

    $content .= '<section class="home-metrics">';
    $content .= '<div class="home-metric"><strong>文档与笔记本</strong><span>保持层级与目录结构</span></div>';
    $content .= '<div class="home-metric"><strong>权限与到期</strong><span>密码、有效期、禁用一应俱全</span></div>';
    $content .= '<div class="home-metric"><strong>集中管理</strong><span>分享列表统一检索与追踪</span></div>';
    $content .= '</section>';

    $content .= '<section class="home-section">';
    $content .= '<h2>核心能力</h2>';
    $content .= '<div class="home-grid">';
    $content .= '<div class="home-card"><h3>完整 Markdown 支持</h3><p>公式、表格、任务列表、Mermaid 与代码高亮全部可用。</p></div>';
    $content .= '<div class="home-card"><h3>统一链接管理</h3><p>软删/恢复/彻底删除，分享状态一目了然。</p></div>';
    $content .= '<div class="home-card"><h3>多用户与审核</h3><p>账号管理、公告发布、违禁词扫描集中处理。</p></div>';
    $content .= '</div>';
    $content .= '</section>';

    $content .= '<section class="home-section">';
    $content .= '<h2>使用流程</h2>';
    $content .= '<div class="home-steps">';
    $content .= '<div class="home-step"><span>1</span> 登录后台生成 API Key</div>';
    $content .= '<div class="home-step"><span>2</span> 插件填写地址与 Key</div>';
    $content .= '<div class="home-step"><span>3</span> 一键验证并同步</div>';
    $content .= '<div class="home-step"><span>4</span> 复制链接对外分享</div>';
    $content .= '</div>';
    $content .= '</section>';

    $content .= '<section class="home-section">';
    $content .= '<h2>适用场景</h2>';
    $content .= '<div class="home-grid">';
    $content .= '<div class="home-card"><h3>产品文档</h3><p>对外发布手册，自动同步更新。</p></div>';
    $content .= '<div class="home-card"><h3>团队知识库</h3><p>内部分享、权限控制、到期管理。</p></div>';
    $content .= '<div class="home-card"><h3>课程与教程</h3><p>长文输出，目录清晰可导航。</p></div>';
    $content .= '</div>';
    $content .= '</section>';

    $footerItems = [];
    if (trim((string)$siteIcp) !== '') {
        $footerItems[] = 'ICP备案：' . htmlspecialchars((string)$siteIcp);
    }
    if (trim((string)$siteContactEmail) !== '') {
        $footerItems[] = '联系邮箱：' . htmlspecialchars((string)$siteContactEmail);
    }
    if (!empty($footerItems)) {
        $content .= '<footer class="home-footer">' . implode(' · ', $footerItems) . '</footer>';
    }
    render_page('首页', $content, null);
}

http_response_code(404);
echo '未找到。';
