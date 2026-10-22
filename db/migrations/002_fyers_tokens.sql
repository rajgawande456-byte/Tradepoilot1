
CREATE TABLE IF NOT EXISTS fyers_credentials (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE
        REFERENCES users(id) ON DELETE CASCADE,
    access_token_encrypted TEXT NOT NULL,
    token_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
