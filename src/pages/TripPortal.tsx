import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Lock, Loader2, ChevronLeft, AlertCircle } from 'lucide-react';
import { supabase } from '../api/supabase';

const TripPortal: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tripName, setTripName] = useState('');

  useEffect(() => {
    // 檢查是否已經驗證過
    const authed = localStorage.getItem(`auth_${id}`);
    if (authed) {
      navigate(`/trip/${id}/dashboard`);
    }
    fetchTripName();
  }, [id, navigate]);

  const fetchTripName = async () => {
    const { data } = await supabase.from('trips').select('name').eq('id', id).single();
    if (data) setTripName(data.name);
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { data, error } = await supabase
        .from('trips')
        .select('access_code')
        .eq('id', id)
        .single();

      if (error) throw error;

      if (data.access_code === code) {
        localStorage.setItem(`auth_${id}`, 'true');
        navigate(`/trip/${id}/dashboard`);
      } else {
        setError('密碼錯誤，請再試一次。');
      }
    } catch (err: any) {
      setError('驗證時發生錯誤: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <button 
          onClick={() => navigate('/')}
          className="flex items-center gap-1 text-gray-500 hover:text-blue-600 transition-colors mb-8"
        >
          <ChevronLeft size={20} />
          <span>返回旅程列表</span>
        </button>

        <div className="bg-white dark:bg-gray-800 p-8 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-700 text-center">
          <div className="bg-blue-100 dark:bg-blue-900/30 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6">
            <Lock className="text-blue-600" size={30} />
          </div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white mb-2">請輸入訪問密碼</h1>
          <p className="text-gray-500 dark:text-gray-400 mb-8">進入 {tripName || '這趟旅程'} 前需要進行驗證</p>

          <form onSubmit={handleVerify} className="space-y-4">
            <input
              type="password"
              maxLength={6}
              placeholder="請輸入 4-6 位密碼"
              className="w-full text-center text-2xl tracking-[1em] px-4 py-3 rounded-xl border-2 dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:border-blue-500 outline-none transition-all"
              value={code}
              onChange={e => setCode(e.target.value)}
              autoFocus
            />

            {error && (
              <div className="flex items-center justify-center gap-2 text-red-600 text-sm">
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
            )}

            <button
              disabled={loading || code.length < 4}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white font-bold py-4 rounded-xl shadow-lg shadow-blue-500/30 transition-all flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="animate-spin" size={20} /> : '確認進入'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default TripPortal;
