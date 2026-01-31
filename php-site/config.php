<?php
return [
    'app_name' => '思源笔记分享',
    'allow_registration' => true,
    'default_storage_limit_mb' => 1024,
    // Session lifetime (days)
    'session_lifetime_days' => 30,
    // Chunk cleanup (seconds, 0.05 = 5% probability per request)
    'chunk_ttl_seconds' => 7200,
    'chunk_cleanup_probability' => 0.05,
    'chunk_cleanup_limit' => 20,
    // Upload chunk size limits (plugin will adapt to these values)
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
    // 'db_path' => __DIR__ . '/storage/app.db',
    // 'uploads_dir' => __DIR__ . '/uploads',

    // Site version shown in dashboard header, 不要改动此项
    'site_version' => '0.3.4',
    // Central stats server used for update heartbeat, 不要改动此项
    'central_stats_url' => 'https://share.b0x.top',
];
