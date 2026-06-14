import { getSimilarCase } from "./actions";
import SimilarClient from "./SimilarClient";

export default async function SimilarPage() {
  const similarCase = await getSimilarCase();
  return <SimilarClient similarCase={similarCase} />;
}
