import { Schema, model, Document } from "mongoose";
const AustinSchema = new Schema({}, { strict: false });
export const AustinModel = model("Austins", AustinSchema, "austins");
