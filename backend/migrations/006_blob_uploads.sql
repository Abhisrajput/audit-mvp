-- Who uploaded which bytes. A document may only be registered by someone who uploaded those bytes
-- themselves, so knowing a SHA-256 never grants access to another user's file.
CREATE TABLE blob_uploads (
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  uploaded_by text NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sha256, uploaded_by)
);
