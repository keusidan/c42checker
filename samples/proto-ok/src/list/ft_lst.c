/* ************************************************************************** */
/*                                                                            */
/*                                                        :::      ::::::::   */
/*   ft_lst.c                                           :+:      :+:    :+:   */
/*                                                    +:+ +:+         +:+     */
/*   By: ponzu <ponzu@student.42tokyo.jp>           +#+  +:+       +#+        */
/*                                                +#+#+#+#+#+   +#+           */
/*   Created: 2026/10/08 12:00:00 by ponzu             #+#    #+#             */
/*   Updated: 2026/10/08 12:00:00 by ponzu            ###   ########.fr       */
/*                                                                            */
/* ************************************************************************** */

#include <stdlib.h>
#include "proj.h"

static void	ft_hidden(void)
{
}

t_list	*ft_lstnew(void *content)
{
	t_list	*node;

	ft_hidden();
	node = malloc(sizeof(t_list));
	if (node == NULL)
		return (NULL);
	node->content = content;
	node->next = NULL;
	return (node);
}

t_list	**ft_lstpick(t_list **lst, void *(*f)(void *))
{
	if (lst != NULL && *lst != NULL)
		(*lst)->content = f((*lst)->content);
	return (lst);
}

unsigned long long	ft_big(unsigned int a, long b)
{
	return ((unsigned long long)a + (unsigned long long)b);
}
