-- TLS certificate pins (trust-on-first-use), business rule 113.
--
-- WinRM over HTTPS and the firmware engines send a password or an API token
-- on connections that do not verify a CA chain (self-signed device and WinRM
-- certificates are the norm). From this release the first such connection to
-- a host:port pins the leaf certificate's SHA-256 fingerprint here, and a later
-- certificate that differs is refused before the secret is sent. The table
-- starts empty on every existing install: the first connection after the
-- update pins whatever answers, so nothing is refused until a certificate
-- CHANGES.
CREATE TABLE "tls_cert_pins" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tls_cert_pins_pkey" PRIMARY KEY ("id")
);

-- One pin per dialed endpoint; tlsCertPinService keys on this.
CREATE UNIQUE INDEX "tls_cert_pins_host_port_key" ON "tls_cert_pins"("host", "port");
