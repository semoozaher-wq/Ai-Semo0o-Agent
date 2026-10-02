import { useLocalSearchParams } from 'expo-router';
import { AgentDetail } from '../../src/screens';

export default function AgentDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentDetail agentId={String(id)} />;
}
