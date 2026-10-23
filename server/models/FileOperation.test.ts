import { randomUUID } from "node:crypto";
import path from "node:path";
import { EmptyResultError } from "sequelize";
import {
  FileOperationFormat,
  FileOperationState,
  FileOperationType,
} from "@shared/types";
import { createContext } from "@server/context";
import {
  buildCollection,
  buildDocument,
  buildFileOperation,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import { ValidateKey } from "@server/validation";
import FileOperation from "./FileOperation";

describe("FileOperation", () => {
  describe("createExport", () => {
    it("should create a team export with the requested options", async () => {
      const team = await buildTeam();
      const user = await buildUser({ teamId: team.id });

      const fileOperation = await FileOperation.createExport(
        createContext({ user }),
        { team, includeAttachments: false, includePrivate: false }
      );

      expect(fileOperation.type).toBe(FileOperationType.Export);
      expect(fileOperation.state).toBe(FileOperationState.Creating);
      expect(fileOperation.format).toBe(FileOperationFormat.MarkdownZip);
      expect(fileOperation.key).toContain(`uploads/${team.id}/`);
      expect(fileOperation.options).toMatchObject({
        includeAttachments: false,
        includePrivate: false,
        exportedDocumentIds: [],
        audit: { channel: "web", traceId: expect.any(String) },
      });
      expect(fileOperation.user.id).toBe(user.id);
    });

    it("should set the collection association for a collection export", async () => {
      const team = await buildTeam();
      const user = await buildUser({ teamId: team.id });
      const collection = await buildCollection({ teamId: team.id });

      const fileOperation = await FileOperation.createExport(
        createContext({ user }),
        { team, collection }
      );

      expect(fileOperation.collectionId).toBe(collection.id);
      expect(fileOperation.collection?.id).toBe(collection.id);
      expect(fileOperation.options).toMatchObject({
        includeAttachments: true,
        includePrivate: true,
        exportedDocumentIds: [],
        audit: { channel: "web", traceId: expect.any(String) },
      });
    });

    it("统一创建入口保存实际文档清单与凭据来源", async () => {
      const team = await buildTeam();
      const user = await buildUser({ teamId: team.id });
      const collection = await buildCollection({
        teamId: team.id,
        userId: user.id,
      });
      const document = await buildDocument({
        teamId: team.id,
        userId: user.id,
        collectionId: collection.id,
      });
      const ctx = createContext({ user });
      ctx.state.securityTraceId = randomUUID();
      ctx.state.credentialId = randomUUID();

      const operation = await FileOperation.createExport(ctx, {
        document,
        format: FileOperationFormat.MarkdownZip,
      });

      expect(operation.document?.id).toBe(document.id);
      expect(operation.options).toMatchObject({
        exportedDocumentIds: [document.id],
        audit: {
          traceId: ctx.state.securityTraceId,
          credentialId: ctx.state.credentialId,
          channel: "web",
        },
      });
    });
  });

  describe("个人导出归档", () => {
    it("文档与集合导出同时保存个人所有者、清单及审计来源", async () => {
      const team = await buildTeam();
      const user = await buildUser({ teamId: team.id });
      const collection = await buildCollection({
        teamId: team.id,
        userId: user.id,
        ownerId: user.id,
        permission: null,
      });
      const document = await buildDocument({
        teamId: team.id,
        userId: user.id,
        collectionId: collection.id,
      });
      const ctx = createContext({ user });
      ctx.state.credentialId = randomUUID();
      const operations = await Promise.all([
        FileOperation.createExport(ctx, {
          document,
          format: FileOperationFormat.MarkdownZip,
        }),
        FileOperation.createExport(ctx, { team, collection }),
      ]);
      for (const operation of operations) {
        expect(operation.options).toMatchObject({
          personalOwnerId: user.id,
          exportedDocumentIds: [document.id],
          audit: { credentialId: ctx.state.credentialId },
        });
      }
    });
  });

  describe("getExportKey", () => {
    it("should write to the uploads bucket", () => {
      const teamId = randomUUID();
      const key = FileOperation.getExportKey({
        name: "My Collection",
        teamId,
        format: FileOperationFormat.MarkdownZip,
      });

      expect(key).toEqual(
        expect.stringMatching(
          new RegExp(
            `^uploads/${teamId}/[^/]+/My Collection-export\\.markdown\\.zip$`
          )
        )
      );
      expect(ValidateKey.isValid(key)).toBe(true);
    });

    it("should not allow the name to traverse to another bucket", () => {
      const key = FileOperation.getExportKey({
        name: `../../../public/${randomUUID()}/${randomUUID()}/x`,
        teamId: randomUUID(),
        format: FileOperationFormat.MarkdownZip,
      });

      expect(key.split("/")).toHaveLength(4);
      // The key must still point inside the uploads bucket once normalized.
      expect(path.posix.normalize(key).startsWith("uploads/")).toBe(true);
    });
  });

  describe("findByPk", () => {
    it("should not allow a passed where to override the id", async () => {
      const team = await buildTeam();
      const user = await buildUser({ teamId: team.id });
      const fileOperation = await buildFileOperation({
        teamId: team.id,
        userId: user.id,
      });
      const other = await buildFileOperation({
        teamId: team.id,
        userId: user.id,
      });

      const found = await FileOperation.findByPk(fileOperation.id, {
        where: { id: other.id },
      });

      expect(found?.id).toEqual(fileOperation.id);
    });

    it("should throw the passed error when rejectOnEmpty is an error", async () => {
      const error = new Error("does not exist");

      await expect(
        FileOperation.findByPk("3a1b2c3d-0000-4000-8000-000000000000", {
          rejectOnEmpty: error,
        })
      ).rejects.toThrow(error);
    });

    it("should throw when rejectOnEmpty is set and the id is not a string", async () => {
      await expect(
        FileOperation.findByPk(123, { rejectOnEmpty: true })
      ).rejects.toThrow(EmptyResultError);
    });
  });
});
