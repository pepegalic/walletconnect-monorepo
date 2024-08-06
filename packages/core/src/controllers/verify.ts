/* eslint-disable no-console */
import { generateChildLogger, getLoggerContext, Logger } from "@walletconnect/logger";
import { IVerify } from "@walletconnect/types";
import {
  getCryptoKeyFromKeyData,
  isBrowser,
  isNode,
  P256KeyDataType,
  verifyP256Jwt,
} from "@walletconnect/utils";
import { FIVE_SECONDS, ONE_SECOND, toMiliseconds } from "@walletconnect/time";
import { getDocument } from "@walletconnect/window-getters";

import { TRUSTED_VERIFY_URLS, VERIFY_CONTEXT, VERIFY_SERVER, VERIFY_SERVER_V2 } from "../constants";
import { IKeyValueStorage } from "@walletconnect/keyvaluestorage";

type jwk = {
  publicKey: P256KeyDataType;
  expiresAt: number;
};
export class Verify extends IVerify {
  public name = VERIFY_CONTEXT;
  private abortController: AbortController;
  private isDevEnv;
  private verifyUrlV2 = VERIFY_SERVER_V2;
  private publicKey?: jwk;

  constructor(public projectId: string, public logger: Logger, public store: IKeyValueStorage) {
    super(projectId, logger, store);
    this.logger = generateChildLogger(logger, this.name);
    this.abortController = new AbortController();
    this.isDevEnv = isNode() && process.env.IS_VITEST;
    console.log("Verify v2 init", this.verifyUrlV2);
    this.init();
  }

  get storeKey(): string {
    return `verify:public:key`;
  }

  public init = async () => {
    if (!isBrowser()) return;
    this.publicKey = await this.store.getItem(this.storeKey);
    console.log("persistedKey", this.publicKey);
    if (this.publicKey && toMiliseconds(this.publicKey?.expiresAt) < Date.now()) {
      console.log("public key expired");
      await this.removePublicKey();
    }
    if (this.publicKey) return;
    const key = await this.fetchPublicKey();
    console.log("public key", key);
    await this.persistPublicKey(key);
  };

  public register: IVerify["register"] = async (params) => {
    if (!isBrowser()) return;
    console.log("register", params);
    const { id, decryptedId } = params;
    const url = `${this.verifyUrlV2}/attestation?projectId=${this.projectId}`;
    let src = "";
    try {
      const response = await fetch(url, {
        method: "POST",
        body: JSON.stringify({ id, decryptedId }),
        headers: {
          origin: "https://8951-78-130-198-143.ngrok-free.app/",
        },
      });
      const { srcdoc } = await response.json();
      src = srcdoc;
    } catch (e) {
      console.error("error", e);
      return;
    }
    console.log("srcdoc", src);
    const document = getDocument() as Document;
    const abortTimeout = this.startAbortTimer(ONE_SECOND * 2);
    const attestatiatonJwt = await new Promise((resolve) => {
      const abortListener = () => {
        document.body.removeChild(iframe);
        window.removeEventListener("message", listener);
        this.abortController.signal.removeEventListener("abort", abortListener);
      };

      this.abortController.signal.addEventListener("abort", abortListener);
      const iframe = document.createElement("iframe");
      iframe.srcdoc = src;
      iframe.src = "https://verify.walletconnect.com";
      iframe.style.display = "none";
      const listener = (event: MessageEvent) => {
        console.log("message event received", event);
        if (!event.data) return;
        const data = JSON.parse(event.data);
        if (data.type === "verify_attestation") {
          // best-practice field
          clearInterval(abortTimeout);
          window.removeEventListener("message", listener);
          document.body.removeChild(iframe);
          this.abortController.signal.removeEventListener("abort", abortListener);
          console.log("attestation", data.attestation);
          resolve(data.attestation === null ? "" : data.attestation);
        }
      };
      document.body.appendChild(iframe);
      window.addEventListener("message", listener);
    });
    console.log("attestatiatonJwt", attestatiatonJwt);
    return attestatiatonJwt as string;
  };

  public resolve: IVerify["resolve"] = async (params) => {
    if (this.isDevEnv) return "";
    const { attestationId, hash } = params;

    console.log("resolve attestation", params);

    if (attestationId === "") {
      console.log("resolve: attestationId is empty string");
      return;
    }

    if (attestationId) {
      const data = await this.isValidJwtAttestation(attestationId);
      console.log("resolve data", data);

      if (data?.hasExpired) {
        console.log("resolve: jwt attestation expired");
        return;
      }

      if (data?.valid) {
        return {
          origin: data.payload.origin,
          isScam: data.payload.isScam,
        };
      }
    }
    if (!hash) return;
    console.log("resolve hash", hash);
    const verifyUrl = this.getVerifyUrl(params?.verifyUrl);
    return this.fetchAttestation(hash, verifyUrl);
  };

  get context(): string {
    return getLoggerContext(this.logger);
  }

  private fetchAttestation = async (attestationId: string, url: string) => {
    this.logger.info(`resolving attestation: ${attestationId} from url: ${url}`);
    // set artificial timeout to prevent hanging
    const timeout = this.startAbortTimer(ONE_SECOND * 5);
    const result = await fetch(`${url}/attestation/${attestationId}`, {
      signal: this.abortController.signal,
    });
    clearTimeout(timeout);
    return result.status === 200 ? await result.json() : undefined;
  };

  private startAbortTimer(timer: number) {
    this.abortController = new AbortController();
    return setTimeout(() => this.abortController.abort(), toMiliseconds(timer));
  }

  private getVerifyUrl = (verifyUrl?: string) => {
    let url = verifyUrl || VERIFY_SERVER;
    if (!TRUSTED_VERIFY_URLS.includes(url)) {
      this.logger.info(
        `verify url: ${url}, not included in trusted list, assigning default: ${VERIFY_SERVER}`,
      );
      url = VERIFY_SERVER;
    }
    return url;
  };

  private fetchPublicKey = async () => {
    this.logger.info(`fetching public key from: ${this.verifyUrlV2}`);
    const timeout = this.startAbortTimer(FIVE_SECONDS);
    const result = await fetch(`${this.verifyUrlV2}/public-key`, {
      signal: this.abortController.signal,
    });
    clearTimeout(timeout);
    return (await result.json()) as jwk;
  };

  private persistPublicKey = async (publicKey: jwk) => {
    console.log(`persisting public key to local storage`, publicKey);
    await this.store.setItem(this.storeKey, publicKey);
    this.publicKey = publicKey;
  };

  private removePublicKey = async () => {
    console.log(`removing public key from local storage`);
    await this.store.removeItem(this.storeKey);
    this.publicKey = undefined;
  };

  private isValidJwtAttestation = async (attestation: string) => {
    if (!this.publicKey) {
      console.log("public key not found");
      return;
    }
    const cryptoKey = await getCryptoKeyFromKeyData(this.publicKey.publicKey);
    const result = await verifyP256Jwt<{
      exp: number;
      id: string;
      origin: string;
      isScam: boolean;
    }>(attestation, cryptoKey);

    return {
      valid: result.verified,
      hasExpired: toMiliseconds(result.payload.payload.exp) < Date.now(),
      payload: result.payload.payload,
    };
  };
}
