import Fuse from "fuse.js";
import {AustinModel} from "./models/Austin.model.js";

export async function registerSearchRoute(fastify) {
  fastify.all("/search", async (request, reply) => {
    try {
      const { query } = request.body;

      console.log("Search query:", query);

      if (!query || query.trim().length === 0) {
        return reply
          .status(400)
          .send({ error: "Query is required" });
      }

      const allProperties = await AustinModel.find();

      const fuse = new Fuse(allProperties, {
        keys: ["Plot", "Full Plot"],
        threshold: 0.5,
        distance: 300,
        minMatchCharLength: 2,
      });

      const results = fuse.search(query);


      return reply.send({
        success: true,
        count: results.length,
        data: results.map((r) => r.item),
      });

    } catch (err) {
      console.error(err);
      return reply.status(500).send({
        error: "Error in search tool",
      });
    }
  });
}
