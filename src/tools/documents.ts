import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YukiClient } from "../yuki-client.js";

/**
 * Register tools for uploading documents to the Yuki archive.
 *
 * The Yuki Archive service stores source documents (PDFs) alongside
 * their financial data. Attaching a PDF to a purchase invoice is
 * strongly recommended for audit compliance.
 *
 * Yuki service: Archive.asmx
 * Method:       UploadDocumentWithData(sessionID, fileName, data, folder,
 *                                      administrationID, currency, amount,
 *                                      costCategory, paymentMethod, project, remarks)
 *
 * Note: Archive.asmx uses sessionID / administrationID (uppercase D).
 */
export function registerDocumentTools(
  server: McpServer,
  client: YukiClient
): void {
  /**
   * upload_document
   *
   * Upload a PDF (or other document) to the Yuki archive with optional
   * financial metadata. This is the recommended way to attach source
   * documents to purchase invoices in Yuki.
   *
   * Use this when:
   *   - A purchase invoice PDF needs to be stored in Yuki's archive
   *   - You want Yuki to process the document automatically (OCR)
   *   - Attaching supporting documents (receipts, bank statements) to bookings
   *
   * Folder IDs (use get_document_folders to retrieve the full list):
   *   - Common folders: purchase invoices, bank statements, general
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    "upload_document",
    {
      description:
        "Upload a document (PDF) to the Yuki archive with financial metadata. " +
        "Use this to attach source documents to purchase invoices or store receipts. " +
        "The document must be provided as a base64-encoded string. " +
        "Call get_document_folders first to find the correct folder ID.",
      inputSchema: {
        fileName: z.string()
          .describe("File name including extension (e.g. 'invoice-2024-0042.pdf')"),
        dataBase64: z.string()
          .describe("File content encoded as a base64 string"),
        folder: z.number().int().optional()
          .describe("Archive folder ID. Use get_document_folders to list available folders."),
        currency: z.string().optional().default("EUR")
          .describe("ISO 4217 currency code for the document amount"),
        amount: z.number().optional()
          .describe("Total amount on the document (e.g. invoice total including VAT)"),
        costCategory: z.string().optional()
          .describe("GL account code for automatic cost categorisation (e.g. '4000')"),
        paymentMethod: z.number().int().optional()
          .describe("Payment method code. 0 = unknown, 1 = transfer, 2 = direct collection"),
        project: z.string().optional()
          .describe("Project code to link this document to a Yuki project"),
        remarks: z.string().optional()
          .describe("Internal remarks shown in the archive"),
        administrationId: z.string().optional()
          .describe("Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var."),
      },
    },
    async ({ fileName, dataBase64, folder, currency, amount, costCategory,
             paymentMethod, project, remarks, administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) {
          throw new Error(
            "administrationId is required (or set YUKI_DOMAIN_ID env var)"
          );
        }

        const sessionID = await client.getSessionID();

        // Archive.asmx uses sessionID / administrationID (uppercase D)
        const result = await client.callSoap({
          service: "Archive.asmx",
          method: "UploadDocumentWithData",
          params: {
            sessionID,
            fileName,
            data: dataBase64,
            ...(folder !== undefined && { folder }),
            administrationID: adminId,
            currency: currency ?? "EUR",
            ...(amount !== undefined && { amount }),
            ...(costCategory !== undefined && { costCategory }),
            ...(paymentMethod !== undefined && { paymentMethod }),
            ...(project !== undefined && { project }),
            ...(remarks !== undefined && { remarks }),
          },
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: true, fileName, result },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  /**
   * get_document_folders
   *
   * List all archive folders available in this Yuki administration.
   * Use this to find the correct folder ID before calling upload_document.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    "get_document_folders",
    {
      description:
        "List all archive folders in the Yuki administration. " +
        "Use this to find the correct folder ID to pass to upload_document.",
      inputSchema: {
        administrationId: z.string().optional()
          .describe("Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var."),
      },
    },
    async ({ administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) {
          throw new Error(
            "administrationId is required (or set YUKI_DOMAIN_ID env var)"
          );
        }

        const sessionID = await client.getSessionID();

        const result = await client.callSoap({
          service: "Archive.asmx",
          method: "DocumentFolders",
          params: {
            sessionID,
            administrationID: adminId,
          },
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, result }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
