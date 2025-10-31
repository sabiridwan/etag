import express from "express";

import crypto from "crypto";
import fetch from "node-fetch";

class Qx7Manager {
  static generateQx7Id(strategy: string, data?: any) {
    switch (strategy) {
      case "random":
        return crypto.randomBytes(16).toString("hex");
      case "cognito":
        // Generate deterministic ID based on cognito user ID only (no fingerprint)
        return crypto
          .createHash("sha256")
          .update(data.cognitoUserId)
          .digest("hex")
          .substring(0, 32);
      default:
        return crypto.randomBytes(16).toString("hex");
    }
  }

  /**
   * Validates that a qx7Id has the correct format (hex string, min 16 chars)
   */
  static isValidQx7Id(qx7Id: any): boolean {
    if (!qx7Id || typeof qx7Id !== "string") {
      return false;
    }
    // Must be hex string (a-f0-9), minimum 16 characters
    return /^[a-f0-9]{16,}$/i.test(qx7Id);
  }

  static cleanEtag(etag: string | undefined): string | null {
    if (!etag) return null;
    return etag.startsWith('"') && etag.endsWith('"')
      ? etag.slice(1, -1)
      : etag;
  }
}

const router = express.Router();

/**
 * Standardized header name helper - converts to lowercase for consistency
 */
function getHeaderName(name: string): string {
  return name.toLowerCase();
}

function getBoolHeader(req: express.Request, header: string): boolean {
  const headerName = getHeaderName(header);
  const value = req.headers[headerName];
  return Array.isArray(value) ? value[0] === "true" : value === "true";
}

function getNumericHeader(
  req: express.Request,
  header: string,
  parseFn: (val: string) => number = parseFloat
): number | null {
  const headerName = getHeaderName(header);
  const val = req.headers[headerName];
  if (val === undefined) return null;
  const valueStr = Array.isArray(val) ? val[0] : val;
  const parsed = parseFn(valueStr);
  return isNaN(parsed) ? null : parsed;
}

function getStringHeader(
  req: express.Request,
  header: string
): string | undefined {
  const headerName = getHeaderName(header);
  const val = req.headers[headerName];
  return Array.isArray(val) ? val[0] : val;
}

function resolveQx7IdAndMethod({
  isIncognito,
  hasLimitedStorage,
  cognitoUserId,
  clientQx7Id,
  dataCleared,
  swIntegrityScore,
  returningFromAuth,
  etagFromHeader,
}: {
  isIncognito: boolean;
  hasLimitedStorage: boolean;
  cognitoUserId?: string;
  clientQx7Id?: string;
  dataCleared: boolean;
  swIntegrityScore: number | null;
  returningFromAuth: boolean;
  etagFromHeader?: string;
}) {
  let qx7Id: string | null = null;
  let isReturning = false;
  let persistenceMethod = "new";

  // Validate and prioritize stored clientQx7Id if available and data wasn't cleared
  if (clientQx7Id && Qx7Manager.isValidQx7Id(clientQx7Id) && !dataCleared) {
    qx7Id = clientQx7Id;
    isReturning = true;
    
    if (cognitoUserId && swIntegrityScore && swIntegrityScore > 0.7) {
      persistenceMethod = "cognito-localStorage-verified";
    } else if (swIntegrityScore && swIntegrityScore > 0.7) {
      persistenceMethod = "localStorage-verified";
    } else if (cognitoUserId) {
      persistenceMethod = "cognito-localStorage-verified";
    } else {
      persistenceMethod = "localStorage";
    }
  } 
  // If clientQx7Id exists but data was cleared, check ETag next
  else if (etagFromHeader && !dataCleared) {
    const cleanedEtag = Qx7Manager.cleanEtag(etagFromHeader);
    if (cleanedEtag && Qx7Manager.isValidQx7Id(cleanedEtag)) {
      qx7Id = cleanedEtag;
      isReturning = true;
      persistenceMethod = swIntegrityScore && swIntegrityScore > 0.5 ? "etag-verified" : "etag";
    }
  }
  
  // If we still don't have a valid ID, continue with other strategies
  if (!qx7Id) {
    // For incognito/limited storage, generate random ID (fresh each time)
    if (isIncognito || hasLimitedStorage) {
      qx7Id = Qx7Manager.generateQx7Id("random", {});
      isReturning = false;
      persistenceMethod = isIncognito
        ? "incognito-random"
        : "limited-storage-random";
    }
    // Cognito recovery - use cognito-only ID (deterministic per user)
    else if (cognitoUserId && returningFromAuth) {
      qx7Id = Qx7Manager.generateQx7Id("cognito", {
        cognitoUserId,
      });
      isReturning = true;
      persistenceMethod = "cognito-post-auth-recovery";
    }
    // Generate new random ID as last resort
    else {
      qx7Id = Qx7Manager.generateQx7Id("random", {});
      isReturning = false;
      persistenceMethod = "new";
    }
  }

  return { qx7Id, isReturning, persistenceMethod };
}

const sendEventToAnalytickz = async (
  rockmanId: string,
  qx7Id: string,
  event: "onboarding-step1" | "onboarding-step2",
  persistenceMethod?: string
) => {
  if (!qx7Id) {
    return;
  }

  try {
    await fetch(`https://bio.analytickz.com/events`, {
      method: "POST",
      body: JSON.stringify({
        utm_cdn: rockmanId,
        event_name: "filter-tag",
        event_args: {
          id: qx7Id,
          other_info: event,
          persistence_method: persistenceMethod,
        },
      }),
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    // Log but don't throw - analytics should not break the main flow
    console.error("Failed to send analytics event:", error);
  }
};

router.get("/onboarding-step1", async (req, res) => {
  try {
    const rockmanId = req.query.rockmanId as string | undefined;

    // Standardized header names (case-insensitive)
    const etagFromHeader = getStringHeader(req, "if-none-match");
    const clientQx7Id = getStringHeader(req, "x-qx7-id");
    const dataCleared = getBoolHeader(req, "x-data-cleared");
    const cognitoUserId = getStringHeader(req, "x-cognito-user-id");
    const returningFromAuth = getBoolHeader(req, "x-returning-from-auth");
    const isIncognito = getBoolHeader(req, "x-incognito-mode");
    const hasLimitedStorage = getBoolHeader(req, "x-limited-storage");
    const swIntegrityScore = getNumericHeader(
      req,
      "x-sw-integrity-score",
      parseFloat
    );

    // Determine visitor ID and persistence method
    const { qx7Id, isReturning, persistenceMethod } = resolveQx7IdAndMethod({
      isIncognito,
      hasLimitedStorage,
      cognitoUserId,
      clientQx7Id,
      dataCleared,
      swIntegrityScore: swIntegrityScore ?? null,
      returningFromAuth,
      etagFromHeader,
    });

    // Handle 304 Not Modified if ETag matches
    if (etagFromHeader) {
      const cleanedEtag = Qx7Manager.cleanEtag(etagFromHeader);
      if (cleanedEtag === qx7Id && Qx7Manager.isValidQx7Id(cleanedEtag)) {
        res.status(304).end();
        return;
      }
    }

    const etag = `"${qx7Id}"`;

    // Log persistence method for metrics
    console.log(`[Qx7] ${persistenceMethod} - ${isReturning ? "returning" : "new"} visitor - ID: ${qx7Id.substring(0, 8)}...`);

    // Send analytics (fire and forget)
    sendEventToAnalytickz(
      rockmanId || "",
      qx7Id,
      "onboarding-step1",
      persistenceMethod
    );

    res.set({
      "ETag": etag,
      "Cache-Control": "private, max-age=3600",
      "x-qx7-id": qx7Id,
      "x-persistence-method": persistenceMethod,
    });
    res.json({ qx7Id, persistenceMethod, isReturning });
  } catch (error) {
    console.error("[Qx7] Error in onboarding-step1:", error);
    // Always return a response even on error
    res.status(500).json({
      error: "Internal server error",
      qx7Id: Qx7Manager.generateQx7Id("random", {}),
    });
  }
});

router.get("/onboarding-step2", async (req, res) => {
  try {
    const rockmanId = req.query.rockmanId as string | undefined;

    // Use same standardized header extraction as step1
    const etagFromHeader = getStringHeader(req, "if-none-match");
    const clientQx7Id = getStringHeader(req, "x-qx7-id");
    const dataCleared = getBoolHeader(req, "x-data-cleared");
    const cognitoUserId = getStringHeader(req, "x-cognito-user-id");
    const returningFromAuth = getBoolHeader(req, "x-returning-from-auth");
    const isIncognito = getBoolHeader(req, "x-incognito-mode");
    const hasLimitedStorage = getBoolHeader(req, "x-limited-storage");
    const swIntegrityScore = getNumericHeader(
      req,
      "x-sw-integrity-score",
      parseFloat
    );

    // Use same resolution logic as step1 for consistency
    const { qx7Id, isReturning, persistenceMethod } = resolveQx7IdAndMethod({
      isIncognito,
      hasLimitedStorage,
      cognitoUserId,
      clientQx7Id,
      dataCleared,
      swIntegrityScore: swIntegrityScore ?? null,
      returningFromAuth,
      etagFromHeader,
    });

    // Handle 304 Not Modified if ETag matches
    if (etagFromHeader) {
      const cleanedEtag = Qx7Manager.cleanEtag(etagFromHeader);
      if (cleanedEtag === qx7Id && Qx7Manager.isValidQx7Id(cleanedEtag)) {
        res.status(304).end();
        return;
      }
    }

    // Log persistence method for metrics
    console.log(`[Qx7 Step2] ${persistenceMethod} - ${isReturning ? "returning" : "new"} visitor - ID: ${qx7Id.substring(0, 8)}...`);

    // Send analytics (fire and forget)
    sendEventToAnalytickz(
      rockmanId || "",
      qx7Id,
      "onboarding-step2",
      persistenceMethod
    );

    const imageBuffer = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      "base64"
    );

    res.status(200);
    res.set({
      "ETag": `"${qx7Id}"`,
      "Cache-Control": "public, max-age=315360000, immutable",
      "Expires": new Date(Date.now() + 31536000000).toUTCString(),
      "Content-Type": "image/gif",
      "Content-Length": imageBuffer.length.toString(),
      "x-qx7-id": qx7Id,
      "x-persistence-method": persistenceMethod,
    });

    res.end(imageBuffer);
  } catch (error) {
    console.error("[Qx7] Error in onboarding-step2:", error);
    // Always return a response even on error - send a valid 1x1 pixel
    const fallbackId = Qx7Manager.generateQx7Id("random", {});
    const imageBuffer = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      "base64"
    );
    res.status(500);
    res.set({
      "Content-Type": "image/gif",
      "Content-Length": imageBuffer.length.toString(),
      "x-qx7-id": fallbackId,
      "x-persistence-method": "error-fallback",
    });
    res.end(imageBuffer);
  }
});

export default router;
