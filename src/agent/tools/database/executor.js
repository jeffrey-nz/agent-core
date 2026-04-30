import { handleMysqlQuery } from "./mysqlHandler.js";
import { createToolDispatcher } from "../dispatcher.js";

const databaseHandlers = {
  query_database: handleMysqlQuery,
};

export const executeDatabaseTool = createToolDispatcher(databaseHandlers);
